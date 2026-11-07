package execution

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
)

// Payload is encoded once and authenticated as exact bytes, so JSONB key
// ordering cannot change a persisted receipt's meaning or signature.
type Receipt struct {
	Payload string `json:"payload"`
	MAC     string `json:"mac"`
}
type Denial struct {
	File        string `json:"file"`
	Address     string `json:"address"`
	Enforcement string `json:"enforcement"`
}
type PlanReceipt struct {
	Version              int        `json:"version"`
	Stage                string     `json:"stage"`
	RunID                string     `json:"runId"`
	WorkspaceID          string     `json:"workspaceId"`
	EvaluationID         string     `json:"evaluationId"`
	PolicyFingerprint    string     `json:"policyFingerprint"`
	Nonce                string     `json:"nonce"`
	PlanSHA256           string     `json:"planSha256"`
	RuntimeSHA256        string     `json:"runtimeSha256"`
	PolicySnapshotSHA256 string     `json:"policySnapshotSha256"`
	AuditSHA256          string     `json:"auditSha256"`
	JournalSHA256        string     `json:"journalSha256"`
	StdoutSHA256         string     `json:"stdoutSha256"`
	Allows               bool       `json:"allows"`
	Denials              []Denial   `json:"denials"`
	Overrides            []Override `json:"overrides"`
}

func receiptKey(value string) ([]byte, error) {
	if !validDigest(value) {
		return nil, errors.New("a private 32-byte native receipt key is required")
	}
	return hex.DecodeString(value)
}
func sealPlan(c Config, r Result) (Receipt, error) {
	if !r.Verified || !r.CgroupEmpty || r.Cancelled {
		return Receipt{}, errors.New("unverified native execution cannot issue plan admission")
	}
	key, e := receiptKey(c.ReceiptKey)
	if e != nil {
		return Receipt{}, e
	}
	p := PlanReceipt{Version: 1, Stage: "plan", RunID: c.RunID, WorkspaceID: c.WorkspaceID, EvaluationID: c.EvaluationID, PolicyFingerprint: c.PolicyFingerprint, Nonce: r.Nonce, PlanSHA256: r.PlanSHA256, RuntimeSHA256: r.RuntimeSHA256, PolicySnapshotSHA256: r.PolicySnapshotSHA256, AuditSHA256: r.AuditSHA256, JournalSHA256: r.JournalSHA256, StdoutSHA256: r.StdoutSHA256, Allows: r.Evidence.Allows, Denials: []Denial{}, Overrides: append([]Override{}, c.Overrides...)}
	seen := map[Denial]bool{}
	for _, policy := range r.Evidence.Policies {
		if policy.Result == "DenyResult" && policy.Enforcement != "advisory" {
			denial := Denial{policy.File, policy.Address, policy.Enforcement}
			if !seen[denial] {
				seen[denial] = true
				p.Denials = append(p.Denials, denial)
			}
		}
	}
	if !p.Allows && len(p.Denials) == 0 {
		return Receipt{}, errors.New("failed native plan has no overridable policy disposition")
	}
	sort.Slice(p.Denials, func(i, j int) bool {
		a, b := p.Denials[i], p.Denials[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Address != b.Address {
			return a.Address < b.Address
		}
		return a.Enforcement < b.Enforcement
	})
	data, e := json.Marshal(p)
	if e != nil || len(data) > 512<<10 {
		return Receipt{}, errors.New("native plan receipt exceeds its bounded schema")
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return Receipt{Payload: base64.RawURLEncoding.EncodeToString(data), MAC: hex.EncodeToString(mac.Sum(nil))}, nil
}
func readReceipt(receipt *Receipt, keyText string) (PlanReceipt, error) {
	var p PlanReceipt
	if receipt == nil || len(receipt.Payload) > 700<<10 {
		return p, errors.New("sealed native plan receipt is required")
	}
	key, e := receiptKey(keyText)
	if e != nil {
		return p, e
	}
	data, e := base64.RawURLEncoding.Strict().DecodeString(receipt.Payload)
	if e != nil || len(data) > 512<<10 {
		return p, errors.New("invalid sealed native plan payload")
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	provided, e := hex.DecodeString(receipt.MAC)
	if e != nil || !hmac.Equal(provided, mac.Sum(nil)) || strictJSON(data, &p) != nil || p.Version != 1 || p.Stage != "plan" {
		return p, errors.New("invalid sealed native plan receipt")
	}
	for _, digest := range []string{p.PolicyFingerprint, p.Nonce, p.PlanSHA256, p.RuntimeSHA256, p.PolicySnapshotSHA256, p.AuditSHA256, p.JournalSHA256, p.StdoutSHA256} {
		if !validDigest(digest) {
			return PlanReceipt{}, errors.New("native receipt lacks required capture identities")
		}
	}
	return p, nil
}
func authorizeApply(c Config, r Result) error {
	p, e := readReceipt(c.PlanReceipt, c.ReceiptKey)
	if e != nil {
		return e
	}
	if c.SavedPlan == nil || p.RunID != c.RunID || p.WorkspaceID != c.WorkspaceID || p.EvaluationID != c.EvaluationID || p.PolicyFingerprint != c.PolicyFingerprint || p.PlanSHA256 != c.SavedPlan.SHA256 || p.RuntimeSHA256 != r.RuntimeSHA256 || p.PolicySnapshotSHA256 != r.PolicySnapshotSHA256 {
		return errors.New("saved plan admission differs from the current run, snapshot or runtime")
	}
	if p.Allows {
		if !sameOverrides(c.Overrides, p.Overrides) {
			return errors.New("native override approvals changed after plan admission")
		}
		return nil
	}
	if len(p.Denials) == 0 {
		return errors.New("failed native plan cannot authorize apply")
	}
	wanted := append([]Override{}, p.Overrides...)
	for _, denial := range p.Denials {
		if denial.Enforcement != "mandatory_overridable" {
			return errors.New("mandatory native policy denial blocks apply")
		}
		key := Override{denial.File, denial.Address}
		found := false
		for _, o := range wanted {
			found = found || o == key
		}
		if !found {
			wanted = append(wanted, key)
		}
	}
	if !sameOverrides(c.Overrides, wanted) {
		return errors.New("native plan lacks exact authorized policy overrides")
	}
	return nil
}
