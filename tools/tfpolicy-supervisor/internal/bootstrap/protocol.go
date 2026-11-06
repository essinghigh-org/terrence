// Package bootstrap implements the non-secret bootstrap transport, not admission
// or evidence signing. No message accepted here is an authenticated policy result.
package bootstrap

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const MaxRequest = 32 << 10
const MaxHandshake = 16 << 10
const Cookie = "6F11ED78A2AB"

// Config comes only from the trusted launcher, never the workspace or shim.
// PID and start time are in the supervisor's /proc PID namespace.
type Config struct {
	SocketPath         string `json:"socket_path"`
	EnginePID          int    `json:"engine_pid"`
	EngineStartTime    uint64 `json:"engine_start_time"`
	PeerUID            uint32 `json:"peer_uid"`
	ShimPath           string `json:"shim_path"`
	ShimSHA256         string `json:"shim_sha256"`
	RecorderPath       string `json:"recorder_path"`
	RecorderConfigPath string `json:"recorder_config_path"`
	RecorderSHA256     string `json:"recorder_sha256"`
	JournalPath        string `json:"journal_path"`
	RunNonce           string `json:"run_nonce"`
	StartupSeconds     int    `json:"startup_seconds"`
	LifetimeSeconds    int    `json:"lifetime_seconds"`
	MaxJournalBytes    int64  `json:"max_journal_bytes"`
}

type Request struct {
	ClientCertificate string `json:"client_certificate"`
	ProtocolVersions  string `json:"protocol_versions"`
	Cookie            string `json:"cookie"`
}

func (c Config) Validate() error {
	for _, p := range []string{c.SocketPath, c.ShimPath, c.RecorderPath, c.RecorderConfigPath, c.JournalPath} {
		if !filepath.IsAbs(p) || filepath.Clean(p) != p {
			return errors.New("paths must be absolute and canonical")
		}
	}
	if len(c.SocketPath) > 100 {
		return errors.New("socket path too long")
	}
	for _, h := range []string{c.ShimSHA256, c.RecorderSHA256, c.RunNonce} {
		b, e := hex.DecodeString(h)
		if e != nil || len(b) != 32 || h != strings.ToLower(h) {
			return errors.New("invalid SHA256 pin or run nonce")
		}
	}
	if c.EnginePID <= 1 || c.EngineStartTime == 0 {
		return errors.New("invalid engine identity")
	}
	if c.StartupSeconds < 1 || c.StartupSeconds > 60 || c.LifetimeSeconds < 1 || c.LifetimeSeconds > 86400 {
		return errors.New("invalid timeout")
	}
	if c.MaxJournalBytes < 1 || c.MaxJournalBytes > 64<<20 {
		return errors.New("invalid journal limit")
	}
	return nil
}

func (r Request) Validate() error {
	if r.Cookie != Cookie {
		return errors.New("invalid policy cookie")
	}
	if len(r.ClientCertificate) > 16<<10 {
		return errors.New("certificate too large")
	}
	block, rest := pem.Decode([]byte(r.ClientCertificate))
	if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
		return errors.New("expected one public certificate only")
	}
	if strings.TrimSpace(r.ClientCertificate) != strings.TrimSpace(string(pem.EncodeToMemory(block))) {
		return errors.New("non-certificate content is forbidden")
	}
	if _, e := x509.ParseCertificate(block.Bytes); e != nil {
		return errors.New("invalid public certificate")
	}
	if len(r.ProtocolVersions) == 0 || len(r.ProtocolVersions) > 128 {
		return errors.New("invalid protocol versions")
	}
	for _, v := range strings.Split(r.ProtocolVersions, ",") {
		n, e := strconv.Atoi(v)
		if e != nil || n < 1 || n > 65535 || strconv.Itoa(n) != v {
			return errors.New("invalid protocol version")
		}
	}
	return nil
}

func ReadLine(r *bufio.Reader, limit int) ([]byte, error) {
	var out []byte
	for {
		b, e := r.ReadSlice('\n')
		if len(out)+len(b) > limit {
			return nil, errors.New("line exceeds limit")
		}
		out = append(out, b...)
		if e == nil {
			return out, nil
		}
		if e != bufio.ErrBufferFull {
			return nil, e
		}
	}
}

func DecodeRequest(line []byte) (Request, error) {
	var r Request
	d := json.NewDecoder(bytes.NewReader(line))
	d.DisallowUnknownFields()
	if e := d.Decode(&r); e != nil {
		return r, e
	}
	if e := d.Decode(new(any)); e != io.EOF {
		return r, errors.New("trailing request data")
	}
	return r, r.Validate()
}

// Handshake validation only prevents accidental/hostile non-plugin stdout. The
// server public certificate is mandatory: plaintext fallback is not accepted.
func ValidateHandshake(line []byte) error {
	if len(line) > MaxHandshake || len(line) == 0 || line[len(line)-1] != '\n' {
		return errors.New("invalid handshake size")
	}
	parts := strings.Split(strings.TrimSuffix(string(line), "\n"), "|")
	if len(parts) < 6 || len(parts) > 7 || parts[0] != "1" || parts[1] != "1" || parts[4] != "grpc" || parts[5] == "" {
		return errors.New("invalid mTLS plugin handshake")
	}
	if parts[2] != "unix" && parts[2] != "tcp" {
		return errors.New("invalid handshake network")
	}
	if parts[3] == "" || strings.ContainsAny(string(line), "\r\x00") {
		return errors.New("invalid handshake address")
	}
	der, e := base64.RawStdEncoding.DecodeString(parts[5])
	if e != nil {
		return errors.New("invalid server certificate encoding")
	}
	if _, e = x509.ParseCertificate(der); e != nil {
		return errors.New("invalid server public certificate")
	}
	return nil
}

func CheckPinned(f *os.File, want string) error {
	h := sha256.New()
	if _, e := io.Copy(h, f); e != nil {
		return e
	}
	if hex.EncodeToString(h.Sum(nil)) != want {
		return errors.New("executable digest mismatch")
	}
	_, e := f.Seek(0, io.SeekStart)
	return e
}

func (c Config) StartupTimeout() time.Duration { return time.Duration(c.StartupSeconds) * time.Second }

func ParseStat(data string) (parent int, start uint64, err error) {
	// comm may contain spaces and parentheses; the final ')' delimits field 2.
	i := strings.LastIndex(data, ") ")
	if i < 0 {
		return 0, 0, errors.New("malformed proc stat")
	}
	f := strings.Fields(data[i+2:])
	if len(f) < 20 {
		return 0, 0, errors.New("short proc stat")
	}
	parent, err = strconv.Atoi(f[1])
	if err != nil || parent < 0 {
		return 0, 0, errors.New("invalid parent pid")
	}
	start, err = strconv.ParseUint(f[19], 10, 64)
	if err != nil || start == 0 {
		return 0, 0, fmt.Errorf("invalid process starttime")
	}
	return
}
