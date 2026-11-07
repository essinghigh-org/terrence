package execution

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func encodeLines(t *testing.T, rows []map[string]any, sequence string) []byte {
	t.Helper()
	var b bytes.Buffer
	for i, row := range rows {
		row[sequence] = i
		if e := json.NewEncoder(&b).Encode(row); e != nil {
			t.Fatal(e)
		}
	}
	return b.Bytes()
}
func decodeLines(t *testing.T, data []byte) []map[string]any {
	t.Helper()
	var rows []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		var row map[string]any
		if e := json.Unmarshal(line, &row); e != nil {
			t.Fatal(e)
		}
		rows = append(rows, row)
	}
	return rows
}
func evidenceFixture(t *testing.T) EvidenceInput {
	nonce := strings.Repeat("a", 64)
	hash := strings.Repeat("b", 64)
	target := Target{"resource", "terraform_data.proof", "Create"}
	rows := []map[string]any{{"event": "start", "phase": 0, "roots": []string{"/snapshot/policies"}}, {"event": "setup", "phase": 0}, {"event": "begin", "phase": 1, "stage": "walkPlan"}, {"event": "inventory", "phase": 1, "targets": []Target{target}}, {"event": "result", "phase": 1, "target": target, "requestSha256": hash, "result": "passed"}, {"event": "end", "phase": 1}, {"event": "complete", "phase": 1, "exitCode": 2}}
	for _, row := range rows {
		row["version"] = 1
		row["nonce"] = nonce
		row["command"] = "plan"
		row["failed"] = false
	}
	rpc := []map[string]any{}
	for i, method := range []string{"Setup", "EvaluateResource"} {
		id := []string{"rpc-0", "rpc-1"}[i]
		for _, phase := range []string{"begin", "end"} {
			row := map[string]any{"id": id, "method": method, "phase": phase, "requestSha256": hash, "result": nil, "error": nil}
			if i == 1 && phase == "end" {
				row["result"] = "ALLOW"
			}
			rpc = append(rpc, row)
		}
	}
	return EvidenceInput{Command: "plan", Nonce: nonce, Roots: []string{"/snapshot/policies"}, ExitCode: 2, CgroupEmpty: true, Audit: encodeLines(t, rows, "sequence"), Journal: encodeLines(t, rpc, "sequence"), Transport: []byte(`{"run_nonce":"` + nonce + `","completed":false,"transport":"engine_shutdown_observed"}`), SavedPlan: testPlanArchive(t, `{"version":4,"resources":[]}`), PlanJSON: []byte(`{"configuration":{"root_module":{}},"format_version":"1.2","terraform_version":"1.17.1","complete":true,"errored":false,"resource_changes":[{"address":"terraform_data.proof","mode":"managed","change":{"actions":["create"]}}]}`)}
}

func TestEvidenceMatchesPlanAndAcceptsValidUnmatchedPolicy(t *testing.T) {
	in := evidenceFixture(t)
	out, e := Verify(in)
	if e != nil || !out.Allows || out.Targets != 1 || len(out.Policies) != 0 {
		t.Fatal(out, e)
	}
}
func TestEvidenceRejectsEntirelyOmittedResourceEvaluation(t *testing.T) {
	in := evidenceFixture(t)
	rows := decodeLines(t, in.Audit)
	rows = append(rows[:3], rows[5:]...)
	in.Audit = encodeLines(t, rows, "sequence")
	rpc := decodeLines(t, in.Journal)
	in.Journal = encodeLines(t, rpc[:2], "sequence")
	out, e := Verify(in)
	if e == nil || out.Allows || !strings.Contains(e.Error(), "coverage") {
		t.Fatal("self-consistent but omitted graph/RPC evidence passed", out, e)
	}
}
func TestEvidenceRejectsCorruptOrStaleExecution(t *testing.T) {
	for name, mutate := range map[string]func(*EvidenceInput){
		"cancel": func(in *EvidenceInput) { in.Cancelled = true }, "survivor": func(in *EvidenceInput) { in.CgroupEmpty = false }, "nonce": func(in *EvidenceInput) { in.Nonce = strings.Repeat("c", 64) }, "stage": func(in *EvidenceInput) { in.Command = "apply" }, "exit": func(in *EvidenceInput) { in.ExitCode = 0 }, "truncated audit": func(in *EvidenceInput) { in.Audit = in.Audit[:len(in.Audit)-1] }, "truncated RPC": func(in *EvidenceInput) { in.Journal = in.Journal[:len(in.Journal)-1] }, "incomplete plan": func(in *EvidenceInput) {
			in.PlanJSON = bytes.Replace(in.PlanJSON, []byte(`"complete":true`), []byte(`"complete":false`), 1)
		}, "forged transport": func(in *EvidenceInput) {
			in.Transport = bytes.Replace(in.Transport, []byte(`"completed":false`), []byte(`"completed":true`), 1)
		},
		"missing result": func(in *EvidenceInput) {
			rows := decodeLines(t, in.Audit)
			rows = append(rows[:4], rows[5:]...)
			in.Audit = encodeLines(t, rows, "sequence")
		},
		"duplicate result": func(in *EvidenceInput) {
			rows := decodeLines(t, in.Audit)
			rows = append(rows[:5], append([]map[string]any{rows[4]}, rows[5:]...)...)
			in.Audit = encodeLines(t, rows, "sequence")
		},
		"RPC crash": func(in *EvidenceInput) {
			rows := decodeLines(t, in.Journal)
			rows[3]["result"] = nil
			rows[3]["error"] = "evaluation RPC failed"
			in.Journal = encodeLines(t, rows, "sequence")
		},
		"callback failure": func(in *EvidenceInput) {
			rows := decodeLines(t, in.Journal)
			rows = append(rows, map[string]any{"id": "rpc-2", "method": "GetDataSource", "phase": "begin", "requestSha256": strings.Repeat("d", 64), "result": nil, "error": nil}, map[string]any{"id": "rpc-2", "method": "GetDataSource", "phase": "end", "requestSha256": strings.Repeat("d", 64), "result": nil, "error": "deferred callback result"})
			in.Journal = encodeLines(t, rows, "sequence")
		},
	} {
		t.Run(name, func(t *testing.T) {
			in := evidenceFixture(t)
			mutate(&in)
			out, e := Verify(in)
			if e == nil || out.Allows {
				t.Fatal("invalid execution accepted", out, e)
			}
		})
	}
}
func TestEvidenceAdvisoryAndOverrideCannotHideRuntimeFailure(t *testing.T) {
	for _, status := range []string{"advisory", "overridden", "denied"} {
		t.Run(status, func(t *testing.T) {
			in := evidenceFixture(t)
			rows := decodeLines(t, in.Audit)
			r := rows[4]
			r["result"] = status
			enforcement := "advisory"
			if status == "overridden" || status == "denied" {
				enforcement = "mandatory_overridable"
			}
			r["policies"] = []PolicyResult{{File: "/snapshot/policies/proof.policy.hcl", Address: "resource_policy.terraform_data.proof", Enforcement: enforcement, Result: "DenyResult"}}
			if status == "overridden" {
				in.Overrides = []Override{{"/snapshot/policies/proof.policy.hcl", "resource_policy.terraform_data.proof"}}
				rows[0]["overrides"] = in.Overrides
			}
			if status == "denied" {
				r["failed"] = true
				rows[6]["failed"] = true
				rows[6]["exitCode"] = 1
				in.ExitCode = 1
			}
			in.Audit = encodeLines(t, rows, "sequence")
			rpc := decodeLines(t, in.Journal)
			rpc[3]["result"] = nil
			rpc[3]["error"] = "policy aggregate denied or unknown"
			in.Journal = encodeLines(t, rpc, "sequence")
			out, e := Verify(in)
			if e != nil || out.Allows != (status != "denied") {
				t.Fatal(out, e)
			}
			rpc[3]["error"] = "evaluation RPC failed"
			in.Journal = encodeLines(t, rpc, "sequence")
			if out, e = Verify(in); e == nil || out.Allows {
				t.Fatal("runtime failure treated as an override", out, e)
			}
		})
	}
}
func TestPlanResourceCoverageIncludesReplacementNoOpAndNestedResources(t *testing.T) {
	data := []byte(`{"format_version":"1.2","terraform_version":"1.17.1","complete":true,"errored":false,"resource_changes":[{"address":"terraform_data.replace","mode":"managed","change":{"actions":["delete","create"]}},{"address":"data.external.lookup","mode":"data","change":{"actions":["read"]}}],"planned_values":{"root_module":{"child_modules":[{"resources":[{"address":"module.child.terraform_data.keep[0]","mode":"managed"}]}]}}}`)
	out, e := planTargets(data)
	if e != nil || len(out) != 3 || out[Target{"resource", "terraform_data.replace", "Delete"}] != 1 || out[Target{"resource", "terraform_data.replace", "Create"}] != 1 || out[Target{"resource", "module.child.terraform_data.keep[0]", "NoOp"}] != 1 {
		t.Fatal(out, e)
	}
}

func TestRefreshOnlyCoverageUsesRefreshedPriorState(t *testing.T) {
	data := []byte(`{"format_version":"1.2","terraform_version":"1.17.1","complete":true,"errored":false,"planned_values":{"root_module":{}},"prior_state":{"values":{"root_module":{"resources":[{"address":"terraform_data.proof","mode":"managed"}]}}}}`)
	out, e := planTargets(data)
	if e != nil || len(out) != 1 || out[Target{"resource", "terraform_data.proof", "NoOp"}] != 1 {
		t.Fatal(out, e)
	}
}
