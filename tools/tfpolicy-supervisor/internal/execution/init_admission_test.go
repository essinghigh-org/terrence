package execution

import (
	"fmt"
	"strings"
	"testing"
)

func TestDeferredInitEvidenceCannotConcealKnownRequiredDenial(t *testing.T) {
	for _, kind := range []string{"provider", "module"} {
		for _, level := range []string{"mandatory", "mandatory_overridable", "approved", "advisory", "pure-unknown"} {
			for _, reverse := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/reverse=%t", kind, level, reverse), func(t *testing.T) {
					in := evidenceFixture(t)
					in.Command = "init"
					in.ExitCode = 0
					target := Target{Kind: kind, Address: "module.child"}
					method := "EvaluateModule"
					if kind == "provider" {
						target.Address = `provider["terraform.io/builtin/terraform"]`
						method = "EvaluateProvider"
					}
					policies := []PolicyResult{{File: "/snapshot/policies/proof.policy.hcl", Address: kind + "_policy.known", Enforcement: level, Result: "DenyResult"}, {File: "/snapshot/policies/proof.policy.hcl", Address: kind + "_policy.unknown", Enforcement: "mandatory", Result: "UnknownResult"}}
					if level == "approved" {
						policies[0].Enforcement = "mandatory_overridable"
						in.Overrides = []Override{{policies[0].File, policies[0].Address}}
					}
					if reverse {
						policies[0], policies[1] = policies[1], policies[0]
					}
					if level == "pure-unknown" {
						policies = []PolicyResult{{File: "/snapshot/policies/proof.policy.hcl", Address: kind + "_policy.unknown", Enforcement: "mandatory", Result: "UnknownResult"}}
					}
					rows := decodeLines(t, in.Audit)
					for _, row := range rows {
						row["command"] = "init"
					}
					rows[0]["overrides"] = in.Overrides
					rows[2]["stage"] = "init"
					rows[3]["targets"] = []Target{target}
					rows[4]["target"] = target
					rows[4]["result"] = "deferred"
					rows[4]["policies"] = policies
					rows[6]["exitCode"] = 0
					in.Audit = encodeLines(t, rows, "sequence")
					rpc := decodeLines(t, in.Journal)
					rpc[2]["method"] = method
					rpc[3]["method"] = method
					rpc[3]["result"] = nil
					rpc[3]["error"] = "policy aggregate denied or unknown"
					in.Journal = encodeLines(t, rpc, "sequence")
					want := level != "mandatory" && level != "mandatory_overridable"
					out, err := Verify(in)
					if want && (err != nil || !out.Allows) {
						t.Fatal("valid init deferral rejected", out, err)
					}
					if !want && (err == nil || out.Allows) {
						t.Fatal("deferred init concealed known required denial", out, err)
					}
				})
			}
		}
	}
}

func TestRequiredUnknownCannotAuthorizePlanOrApplyEvenWithSoftDenial(t *testing.T) {
	for _, stage := range []string{"plan", "apply"} {
		in := evidenceFixture(t)
		in.Command = stage
		in.ExitCode = 1
		rows := decodeLines(t, in.Audit)
		for _, row := range rows {
			row["command"] = stage
		}
		if stage == "apply" {
			rows[2]["stage"] = "walkApply"
		}
		rows[4]["result"] = "denied"
		rows[4]["failed"] = true
		rows[4]["policies"] = []PolicyResult{{File: "/snapshot/policies/proof.policy.hcl", Address: "resource_policy.known", Enforcement: "mandatory_overridable", Result: "DenyResult"}, {File: "/snapshot/policies/proof.policy.hcl", Address: "resource_policy.unknown", Enforcement: "mandatory", Result: "UnknownResult"}}
		rows[6]["exitCode"] = 1
		rows[6]["failed"] = true
		in.Audit = encodeLines(t, rows, "sequence")
		rpc := decodeLines(t, in.Journal)
		rpc[3]["result"] = nil
		rpc[3]["error"] = "policy aggregate denied or unknown"
		in.Journal = encodeLines(t, rpc, "sequence")
		out, err := Verify(in)
		if err == nil || out.Allows || !strings.Contains(err.Error(), "unknown") {
			t.Fatal("unresolved required policy yielded verifiable overridable admission", stage, out, err)
		}
	}
}
