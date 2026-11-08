package execution

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func testPlanArchive(t *testing.T, state string) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	w, e := z.Create("tfstate")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = w.Write([]byte(state)); e != nil {
		t.Fatal(e)
	}
	if e = z.Close(); e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}
func TestEvidenceRejectsEntirelyOmittedProviderAndModule(t *testing.T) {
	for _, kind := range []string{"provider", "module"} {
		t.Run(kind, func(t *testing.T) {
			in := evidenceFixture(t)
			var plan map[string]any
			if e := json.Unmarshal(in.PlanJSON, &plan); e != nil {
				t.Fatal(e)
			}
			target := Target{Kind: kind, Address: "module.empty"}
			configuration := map[string]any{"root_module": map[string]any{"module_calls": map[string]any{"empty": map[string]any{"module": map[string]any{}}}}}
			if kind == "provider" {
				target.Address = `provider["terraform.io/builtin/terraform"]`
				configuration = map[string]any{"provider_config": map[string]any{"terraform": map[string]any{"full_name": "terraform.io/builtin/terraform"}}, "root_module": map[string]any{"resources": []any{map[string]any{"provider_config_key": "terraform"}}}}
			}
			plan["configuration"] = configuration
			in.PlanJSON, _ = json.Marshal(plan)
			if out, e := Verify(in); e == nil || out.Allows || !strings.Contains(e.Error(), "coverage") {
				t.Fatal("omitted entire metadata registration/RPC passed", out, e)
			}
			rows := decodeLines(t, in.Audit)
			rows[3]["targets"] = []Target{{"resource", "terraform_data.proof", "Create"}, target}
			added := map[string]any{"version": 1, "command": "plan", "event": "result", "phase": 1, "nonce": in.Nonce, "failed": false, "target": target, "requestSha256": strings.Repeat("c", 64), "result": "passed"}
			rows = append(rows[:5], append([]map[string]any{added}, rows[5:]...)...)
			in.Audit = encodeLines(t, rows, "sequence")
			rpc := decodeLines(t, in.Journal)
			method := "EvaluateProvider"
			if kind == "module" {
				method = "EvaluateModule"
			}
			for _, phase := range []string{"begin", "end"} {
				r := map[string]any{"id": "rpc-metadata", "method": method, "phase": phase, "requestSha256": strings.Repeat("c", 64), "result": nil, "error": nil}
				if phase == "end" {
					r["result"] = "ALLOW"
				}
				rpc = append(rpc, r)
			}
			in.Journal = encodeLines(t, rpc, "sequence")
			if out, e := Verify(in); e != nil || !out.Allows {
				t.Fatal("complete independent metadata coverage failed", out, e)
			}
		})
	}
}
func TestIndependentMetadataInventoryResolvesAliasesModulesAndOrphanState(t *testing.T) {
	data := []byte(`{"configuration":{"provider_config":{"aws.west":{"full_name":"registry.terraform.io/hashicorp/aws","alias":"west"},"module.legacy:terraform":{"full_name":"terraform.io/builtin/terraform","module_address":"module.legacy"}},"root_module":{"resources":[{"provider_config_key":"aws.west"}],"module_calls":{"child":{"module":{"resources":[{"provider_config_key":"aws.west"}],"module_calls":{"empty":{"module":{}}}}},"legacy":{"module":{"resources":[{"provider_config_key":"module.legacy:terraform"}]}}}}}}`)
	archive := testPlanArchive(t, `{"version":4,"resources":[{"mode":"managed","provider":"provider[\"registry.terraform.io/hashicorp/random\"].orphan","instances":[{}]}]}`)
	out, e := metadataTargets(data, archive)
	if e != nil || len(out) != 6 || out[Target{Kind: "provider", Address: `provider["registry.terraform.io/hashicorp/aws"].west`}] != 1 || out[Target{Kind: "provider", Address: `module.legacy.provider["terraform.io/builtin/terraform"]`}] != 1 || out[Target{Kind: "provider", Address: `provider["registry.terraform.io/hashicorp/random"].orphan`}] != 1 || out[Target{Kind: "module", Address: "module.child.module.empty"}] != 1 {
		t.Fatal(out, e)
	}
	for _, bad := range [][]byte{nil, []byte("not a zip"), testPlanArchive(t, `{"version":3}`)} {
		if _, e = metadataTargets(data, bad); e == nil {
			t.Fatal("invalid archive inventory accepted")
		}
	}
}
