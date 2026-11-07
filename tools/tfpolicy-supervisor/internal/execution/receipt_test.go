package execution

import (
	"strings"
	"testing"
)

func receiptFixture(t *testing.T) (Config, Result) {
	t.Helper()
	hash := strings.Repeat("a", 64)
	c := Config{RunID: "run-one", WorkspaceID: "ws-one", EvaluationID: "eval-one", PolicyFingerprint: hash, ReceiptKey: strings.Repeat("b", 64), SavedPlan: &PinnedFile{Path: "/private/tfplan", SHA256: hash}}
	r := Result{Verified: true, CgroupEmpty: true, Nonce: hash, PlanSHA256: hash, RuntimeSHA256: hash, PolicySnapshotSHA256: hash, AuditSHA256: hash, JournalSHA256: hash, StdoutSHA256: hash, Evidence: Evidence{Allows: true}}
	receipt, e := sealPlan(c, r)
	if e != nil {
		t.Fatal(e)
	}
	c.PlanReceipt = &receipt
	return c, r
}
func TestSavedApplyRequiresAuthenticatedExactPlanAdmission(t *testing.T) {
	c, r := receiptFixture(t)
	if e := authorizeApply(c, r); e != nil {
		t.Fatal(e)
	}
	for name, mutate := range map[string]func(*Config, *Result){
		"missing": func(c *Config, _ *Result) { c.PlanReceipt = nil }, "signature": func(c *Config, _ *Result) { c.PlanReceipt.MAC = strings.Repeat("0", 64) }, "key": func(c *Config, _ *Result) { c.ReceiptKey = strings.Repeat("c", 64) }, "run": func(c *Config, _ *Result) { c.RunID = "run-other" }, "workspace": func(c *Config, _ *Result) { c.WorkspaceID = "ws-other" }, "evaluation": func(c *Config, _ *Result) { c.EvaluationID = "eval-other" }, "configuration": func(c *Config, _ *Result) { c.PolicyFingerprint = strings.Repeat("c", 64) }, "plan": func(c *Config, _ *Result) { c.SavedPlan.SHA256 = strings.Repeat("c", 64) }, "runtime": func(_ *Config, r *Result) { r.RuntimeSHA256 = strings.Repeat("c", 64) }, "snapshot": func(_ *Config, r *Result) { r.PolicySnapshotSHA256 = strings.Repeat("c", 64) }, "new override": func(c *Config, _ *Result) { c.Overrides = []Override{{"/other/policy.hcl", "policy.other"}} },
	} {
		t.Run(name, func(t *testing.T) {
			c, r := receiptFixture(t)
			mutate(&c, &r)
			if authorizeApply(c, r) == nil {
				t.Fatal("stale or forged plan admission accepted")
			}
		})
	}
}
func TestMandatoryDenialCannotBecomeSavedPlanAdmission(t *testing.T) {
	for _, level := range []string{"mandatory", "mandatory_overridable"} {
		t.Run(level, func(t *testing.T) {
			c, r := receiptFixture(t)
			r.Evidence = Evidence{Allows: false, Policies: []PolicyResult{{File: "/snapshot/policy.hcl", Address: "resource_policy.proof", Result: "DenyResult", Enforcement: level}}}
			receipt, e := sealPlan(c, r)
			if e != nil {
				t.Fatal(e)
			}
			c.PlanReceipt = &receipt
			if authorizeApply(c, r) == nil {
				t.Fatal("denied plan admitted without override")
			}
			c.Overrides = []Override{{"/snapshot/policy.hcl", "resource_policy.proof"}}
			if e = authorizeApply(c, r); (e == nil) != (level == "mandatory_overridable") {
				t.Fatal("mandatory/overridable distinction lost", e)
			}
		})
	}
	c, r := receiptFixture(t)
	r.Verified = false
	if _, e := sealPlan(c, r); e == nil {
		t.Fatal("unverified stage signed")
	}
}
