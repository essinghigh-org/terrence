// Package recorder transparently forwards the pinned native Terraform policy protocol.
// It records evidence, never evaluates HCL or authorizes an apply.
package recorder

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"

	pb "google.golang.org/protobuf/proto"
)

const MaxJournalBytes = 16 * 1024 * 1024
const MaxJournalRecords = 100000

type Record struct {
	Sequence      int     `json:"sequence"`
	ID            string  `json:"id"`
	Method        string  `json:"method"`
	Phase         string  `json:"phase"`
	RequestSHA256 string  `json:"requestSha256"`
	Result        *string `json:"result"`
	Error         *string `json:"error"`
}
type call struct{ id, method, hash string }
type Journal struct {
	mu                      sync.Mutex
	writer                  io.Writer
	abort                   func()
	sequence, bytes, nextID int
	failed                  bool
	setupStarted, ready     bool
	active                  map[uint32]bool
}

func NewJournal(w io.Writer, abort func()) *Journal {
	return &Journal{writer: w, abort: abort, active: make(map[uint32]bool)}
}
func (j *Journal) writeLocked(r Record) error {
	if j.failed {
		return errors.New("journal unavailable")
	}
	r.Sequence = j.sequence
	data, err := json.Marshal(r)
	if err == nil {
		data = append(data, '\n')
	}
	if err != nil || j.sequence >= MaxJournalRecords || j.bytes+len(data) > MaxJournalBytes {
		j.failed = true
		if j.abort != nil {
			go j.abort()
		}
		return errors.New("journal limit or encoding failure")
	}
	n, err := j.writer.Write(data)
	if err != nil || n != len(data) {
		j.failed = true
		if j.abort != nil {
			go j.abort()
		}
		return errors.New("journal write failed")
	}
	j.sequence++
	j.bytes += n
	return nil
}
func (j *Journal) begin(method string, req pb.Message) (call, error) {
	data, err := (pb.MarshalOptions{Deterministic: true}).Marshal(req)
	if err != nil {
		return call{}, errors.New("request encoding failed")
	}
	sum := sha256.Sum256(data)
	j.mu.Lock()
	defer j.mu.Unlock()
	c := call{fmt.Sprintf("rpc-%d", j.nextID), method, hex.EncodeToString(sum[:])}
	j.nextID++
	return c, j.writeLocked(Record{ID: c.id, Method: c.method, Phase: "begin", RequestSHA256: c.hash})
}
func (j *Journal) end(c call, allow bool, failure string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	r := Record{ID: c.id, Method: c.method, Phase: "end", RequestSHA256: c.hash}
	if allow {
		v := "ALLOW"
		r.Result = &v
	}
	if failure != "" {
		r.Error = &failure
	}
	return j.writeLocked(r)
}
func (j *Journal) startSetup() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.setupStarted {
		return false
	}
	j.setupStarted = true
	return true
}
func (j *Journal) setReady(ok bool) { j.mu.Lock(); defer j.mu.Unlock(); j.ready = ok }
func (j *Journal) admitted() bool   { j.mu.Lock(); defer j.mu.Unlock(); return j.ready && !j.failed }
func (j *Journal) startEvaluation(id uint32) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.active[id] {
		return false
	}
	j.active[id] = true
	return true
}
func (j *Journal) finishEvaluation(id uint32) { j.mu.Lock(); defer j.mu.Unlock(); delete(j.active, id) }
func (j *Journal) callbackAllowed(id uint32) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.ready && !j.failed && j.active[id]
}
