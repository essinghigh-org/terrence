package execution

import (
	"strings"
	"testing"
)

func TestRuntimeIdentityBindsBytesAndAllowsDifferentInstallationPaths(t *testing.T) {
	hash := strings.Repeat("a", 64)
	runtime := Runtime{Engine: PinnedFile{"/server/terraform", hash}, PatchSHA256: hash}
	before := RuntimeIdentitySHA256(runtime)
	runtime.Engine.Path = "/agent/engine"
	if RuntimeIdentitySHA256(runtime) != before {
		t.Fatal("physical installation path changed artifact identity")
	}
	runtime.Engine.SHA256 = strings.Repeat("b", 64)
	if RuntimeIdentitySHA256(runtime) == before {
		t.Fatal("different engine bytes retained runtime identity")
	}
}

func TestSavedOverrideReceiptRebasesOnlyWithinSameSnapshot(t *testing.T) {
	c, r := receiptFixture(t)
	r.Evidence = Evidence{Allows: false, Policies: []PolicyResult{{File: "/snapshot/nested/proof.policy.hcl", Address: "resource_policy.proof", Enforcement: "mandatory_overridable", Result: "DenyResult"}}}
	receipt, err := sealPlan(c, r)
	if err != nil {
		t.Fatal(err)
	}
	c.PlanReceipt = &receipt
	c.PolicyRoots = []string{"/agent/private/snapshot"}
	c.Overrides = []Override{{"/agent/private/snapshot/nested/proof.policy.hcl", "resource_policy.proof"}}
	if err = authorizeApply(c, r); err != nil {
		t.Fatal("same snapshot at new host path was rejected", err)
	}
	for _, file := range []string{"/snapshot/nested/proof.policy.hcl", "/agent/private/snapshot-other/nested/proof.policy.hcl", "/agent/private/snapshot/wrong.policy.hcl"} {
		c.Overrides = []Override{{file, "resource_policy.proof"}}
		if authorizeApply(c, r) == nil {
			t.Fatal("override was rebound to another policy", file)
		}
	}
}
