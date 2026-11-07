// Package execution owns native policy execution outside the untrusted run.
// Evidence is useful only with pinned executables, protected capture and an
// immutable plan. It is not itself a portable or authenticated admission token.
package execution

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"reflect"
	"strings"
)

const CaptureLimit = 16 << 20

type Target struct {
	Kind      string `json:"kind"`
	Address   string `json:"address"`
	Operation string `json:"operation"`
}
type Override struct {
	File    string `json:"file"`
	Address string `json:"address"`
}
type PolicyResult struct {
	File        string `json:"file"`
	Address     string `json:"address"`
	Enforcement string `json:"enforcement"`
	Result      string `json:"result"`
}
type AuditRecord struct {
	Version       int            `json:"version"`
	Sequence      *int           `json:"sequence"`
	Nonce         string         `json:"nonce"`
	Command       string         `json:"command"`
	Event         string         `json:"event"`
	Phase         *int           `json:"phase"`
	Stage         string         `json:"stage,omitempty"`
	Roots         []string       `json:"roots,omitempty"`
	Targets       []Target       `json:"targets,omitempty"`
	Target        *Target        `json:"target,omitempty"`
	RequestSHA256 string         `json:"requestSha256,omitempty"`
	Result        string         `json:"result,omitempty"`
	Policies      []PolicyResult `json:"policies,omitempty"`
	Failed        *bool          `json:"failed"`
	ExitCode      *int           `json:"exitCode,omitempty"`
	Overrides     []Override     `json:"overrides,omitempty"`
}

type EvidenceInput struct {
	Command                                        string
	Nonce                                          string
	Roots                                          []string
	Overrides                                      []Override
	ExitCode                                       int
	Cancelled                                      bool
	CgroupEmpty                                    bool
	Audit, Journal, Transport, PlanJSON, SavedPlan []byte
}
type Evidence struct {
	Allows   bool           `json:"allows"`
	Targets  int            `json:"targets"`
	Policies []PolicyResult `json:"policies"`
}
type binding struct{ method, hash string }

func validDigest(value string) bool {
	b, e := hex.DecodeString(value)
	return e == nil && len(b) == 32 && value == strings.ToLower(value)
}
func strictJSON(data []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if e := d.Decode(out); e != nil {
		return e
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}
func lines(data []byte, visit func(int, []byte) error) error {
	if len(data) == 0 || len(data) > CaptureLimit || data[len(data)-1] != '\n' {
		return errors.New("missing, truncated or oversized evidence")
	}
	s := bufio.NewScanner(bytes.NewReader(data))
	s.Buffer(make([]byte, 4096), CaptureLimit)
	index := 0
	for s.Scan() {
		if index >= 100000 {
			return errors.New("evidence record limit exceeded")
		}
		if e := visit(index, s.Bytes()); e != nil {
			return e
		}
		index++
	}
	return s.Err()
}
func validTarget(t Target) bool {
	if t.Address == "" || len(t.Address) > 4096 {
		return false
	}
	if t.Kind == "provider" || t.Kind == "module" {
		return t.Operation == ""
	}
	return t.Kind == "resource" && (t.Operation == "Create" || t.Operation == "Update" || t.Operation == "Delete" || t.Operation == "NoOp")
}
func inRoots(path string, roots []string) bool {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return false
	}
	for _, root := range roots {
		r, e := filepath.Rel(root, path)
		if e == nil && r != "." && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) && !filepath.IsAbs(r) {
			return true
		}
	}
	return false
}

// Verify joins the engine's protected inventory to observed RPCs and compares
// resource coverage with independently decoded saved-plan JSON. The caller must
// generate that JSON with the pinned engine after making the plan immutable.
// Only init/plan/saved-plan apply are accepted; direct apply is not admission.
func Verify(in EvidenceInput) (out Evidence, err error) {
	out = Evidence{Allows: true, Policies: []PolicyResult{}}
	defer func() {
		if err != nil {
			out = Evidence{}
		}
	}()
	if in.Cancelled || !in.CgroupEmpty || !validDigest(in.Nonce) || len(in.Roots) == 0 {
		return out, errors.New("execution was cancelled, unconfined or lacks identity")
	}
	for _, root := range in.Roots {
		if !filepath.IsAbs(root) || filepath.Clean(root) != root || root == "/" {
			return out, errors.New("invalid immutable policy root")
		}
	}
	var transport struct {
		Nonce     string `json:"run_nonce"`
		Completed *bool  `json:"completed"`
		Transport string `json:"transport"`
	}
	if strictJSON(in.Transport, &transport) != nil || transport.Nonce != in.Nonce || transport.Completed == nil || *transport.Completed || (transport.Transport != "engine_shutdown_observed" && transport.Transport != "recorder_exited_cleanly") {
		return out, errors.New("incomplete native transport")
	}
	wantStage := map[string]map[string]bool{"init": {"init": true}, "plan": {"walkPlan": true, "walkPlanDestroy": true}, "apply": {"walkApply": true, "walkDestroy": true}}[in.Command]
	if wantStage == nil {
		return out, errors.New("unsupported native command")
	}
	setup, active, complete := false, false, false
	phase := 0
	expected, observed, resources := map[Target]int{}, map[Target]int{}, map[Target]int{}
	bindings := map[binding][]string{}
	err = lines(in.Audit, func(index int, line []byte) error {
		var r AuditRecord
		if strictJSON(line, &r) != nil || r.Version != 1 || r.Sequence == nil || *r.Sequence != index || r.Nonce != in.Nonce || r.Command != in.Command || r.Phase == nil || r.Failed == nil || complete {
			return errors.New("invalid native audit frame")
		}
		if index == 0 {
			if r.Event != "start" || *r.Phase != 0 || *r.Failed || !reflect.DeepEqual(r.Roots, in.Roots) || !sameOverrides(r.Overrides, in.Overrides) {
				return errors.New("native snapshot or override identity mismatch")
			}
			return nil
		}
		switch r.Event {
		case "setup":
			if setup || phase != 0 || *r.Phase != 0 || *r.Failed {
				return errors.New("invalid Setup ordering")
			}
			setup = true
		case "begin":
			if !setup || active || phase != 0 || *r.Phase != 1 || !wantStage[r.Stage] || *r.Failed {
				return errors.New("unexpected or repeated native phase")
			}
			phase = 1
			active = true
		case "inventory", "result", "end":
			if !active || *r.Phase != phase {
				return errors.New("native result outside active phase")
			}
		case "complete":
			if !setup || active || phase != 1 || *r.Phase != phase || r.ExitCode == nil || *r.ExitCode != in.ExitCode {
				return errors.New("missing native completion or exit mismatch")
			}
			if (in.ExitCode == 0 || in.Command == "plan" && in.ExitCode == 2) == *r.Failed {
				return errors.New("contradictory native completion")
			}
			complete = true
			out.Allows = out.Allows && !*r.Failed
			return nil
		default:
			return errors.New("unknown native audit event")
		}
		if r.Event == "begin" || r.Event == "inventory" {
			for _, t := range r.Targets {
				if !validTarget(t) {
					return errors.New("invalid native inventory target")
				}
				expected[t]++
			}
		}
		if r.Event == "result" {
			if r.Target == nil || !validTarget(*r.Target) || !validDigest(r.RequestSHA256) || observed[*r.Target] >= expected[*r.Target] {
				return errors.New("missing, duplicate or unregistered native evaluation")
			}
			observed[*r.Target]++
			out.Targets++
			if r.Target.Kind == "resource" {
				resources[*r.Target]++
			}
			if e := verifyPolicyResult(r, in); e != nil {
				return e
			}
			out.Policies = append(out.Policies, r.Policies...)
			allows := r.Result == "passed" || r.Result == "advisory" || r.Result == "overridden" || in.Command == "init" && r.Result == "deferred"
			if allows == *r.Failed {
				return errors.New("contradictory native policy classification")
			}
			out.Allows = out.Allows && allows
			method := map[string]string{"resource": "EvaluateResource", "provider": "EvaluateProvider", "module": "EvaluateModule"}[r.Target.Kind]
			key := binding{method, r.RequestSHA256}
			bindings[key] = append(bindings[key], r.Result)
		}
		if r.Event == "end" {
			if !reflect.DeepEqual(expected, observed) {
				return errors.New("native phase omitted expected evaluations")
			}
			active = false
			out.Allows = out.Allows && !*r.Failed
		}
		return nil
	})
	if err != nil {
		return Evidence{}, err
	}
	if !complete {
		return Evidence{}, errors.New("native command omitted completion")
	}
	if err = verifyJournal(in.Journal, bindings); err != nil {
		return Evidence{}, err
	}
	if in.Command != "init" {
		targets, e := planTargets(in.PlanJSON)
		if e != nil {
			return Evidence{}, e
		}
		if !reflect.DeepEqual(targets, resources) {
			return Evidence{}, errors.New("native resource coverage differs from immutable saved plan")
		}
		metadata, e := metadataTargets(in.PlanJSON, in.SavedPlan)
		if e != nil {
			return Evidence{}, e
		}
		actual := map[Target]int{}
		for target, count := range observed {
			if target.Kind != "resource" {
				actual[target] = count
			}
		}
		if !reflect.DeepEqual(metadata, actual) {
			return Evidence{}, errors.New("native provider/module coverage differs from immutable saved plan")
		}
	}
	return out, nil
}

func sameOverrides(a, b []Override) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[Override]bool{}
	for _, v := range a {
		if seen[v] {
			return false
		}
		seen[v] = true
	}
	for _, v := range b {
		if !seen[v] {
			return false
		}
		delete(seen, v)
	}
	return len(seen) == 0
}
func verifyPolicyResult(r AuditRecord, in EvidenceInput) error {
	if !map[string]bool{"passed": true, "advisory": true, "overridden": true, "denied": true, "unknown": true, "error": true, "deferred": in.Command == "init"}[r.Result] {
		return errors.New("invalid native policy result")
	}
	seen := map[Override]bool{}
	for _, p := range r.Policies {
		key := Override{p.File, p.Address}
		if !inRoots(p.File, in.Roots) || p.Address == "" || seen[key] || !map[string]bool{"mandatory": true, "mandatory_overridable": true, "advisory": true}[p.Enforcement] {
			return errors.New("invalid policy identity or enforcement")
		}
		seen[key] = true
		switch p.Result {
		case "AllowResult":
		case "DenyResult", "UnknownResult":
			if p.Result == "UnknownResult" && p.Enforcement != "advisory" && in.Command != "init" {
				return errors.New("required unknown policy result cannot authorize plan or apply")
			}
			if r.Result == "deferred" && p.Result == "DenyResult" && p.Enforcement != "advisory" {
				approved := false
				for _, override := range in.Overrides {
					approved = approved || override == key
				}
				if p.Enforcement != "mandatory_overridable" || !approved {
					return errors.New("init deferral concealed a known required policy denial")
				}
			}
			if r.Result == "passed" {
				return errors.New("ALLOW concealed a failed policy")
			}
			if r.Result == "advisory" && p.Enforcement != "advisory" {
				return errors.New("mandatory failure classified as advisory")
			}
			if r.Result == "overridden" && p.Enforcement != "advisory" {
				approved := false
				for _, o := range in.Overrides {
					approved = approved || o == key
				}
				if p.Result != "DenyResult" || p.Enforcement != "mandatory_overridable" || !approved {
					return errors.New("unauthorized native policy override")
				}
			}
		default:
			if r.Result != "error" {
				return errors.New("invalid policy decision")
			}
		}
	}
	if (r.Result == "advisory" || r.Result == "overridden" || r.Result == "denied") && len(r.Policies) == 0 {
		return errors.New("policy disposition has no policy identity")
	}
	return nil
}

type journalRecord struct {
	Sequence      *int    `json:"sequence"`
	ID            string  `json:"id"`
	Method        string  `json:"method"`
	Phase         string  `json:"phase"`
	RequestSHA256 string  `json:"requestSha256"`
	Result        *string `json:"result"`
	Error         *string `json:"error"`
}

func verifyJournal(data []byte, bindings map[binding][]string) error {
	pending := map[string]binding{}
	seen := map[string]bool{}
	setup := false
	setupStarted := false
	err := lines(data, func(index int, line []byte) error {
		var r journalRecord
		var fields map[string]json.RawMessage
		if strictJSON(line, &r) != nil || json.Unmarshal(line, &fields) != nil || len(fields) != 7 || r.Sequence == nil || *r.Sequence != index || r.ID == "" || !validDigest(r.RequestSHA256) {
			return errors.New("invalid native RPC journal frame")
		}
		if !map[string]bool{"Setup": true, "EvaluateResource": true, "EvaluateProvider": true, "EvaluateModule": true, "GetResources": true, "GetDataSource": true}[r.Method] {
			return errors.New("unknown native RPC method")
		}
		key := binding{r.Method, r.RequestSHA256}
		if r.Phase == "begin" {
			if seen[r.ID] || r.Result != nil || r.Error != nil || r.Method != "Setup" && !setup {
				return errors.New("invalid native RPC begin")
			}
			if r.Method == "Setup" {
				if setupStarted || len(pending) != 0 {
					return errors.New("repeated native RPC Setup")
				}
				setupStarted = true
			}
			seen[r.ID] = true
			pending[r.ID] = key
			return nil
		}
		p, ok := pending[r.ID]
		if r.Phase != "end" || !ok || p != key {
			return errors.New("unmatched native RPC completion")
		}
		delete(pending, r.ID)
		if strings.HasPrefix(r.Method, "Evaluate") {
			matches := bindings[key]
			if len(matches) == 0 {
				return errors.New("RPC evaluation absent from protected native audit")
			}
			status := matches[0]
			bindings[key] = matches[1:]
			if r.Error != nil {
				if status == "passed" || (*r.Error != "policy aggregate denied or unknown" && *r.Error != "policy detail denied, unknown, or diagnostic error") {
					return errors.New("native evaluation transport or classification failed")
				}
			} else if r.Result == nil || *r.Result != "ALLOW" || status == "error" {
				return errors.New("invalid native evaluation decision binding")
			}
		} else {
			if r.Error != nil || r.Result != nil {
				return errors.New("native Setup or callback failed")
			}
			if r.Method == "Setup" {
				setup = true
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if !setup || len(pending) != 0 {
		return errors.New("incomplete native RPC journal")
	}
	for _, matches := range bindings {
		if len(matches) != 0 {
			return errors.New("native result lacks observed RPC")
		}
	}
	return nil
}

type planResource struct {
	Address string `json:"address"`
	Mode    string `json:"mode"`
}
type planModule struct {
	Resources []planResource `json:"resources"`
	Children  []planModule   `json:"child_modules"`
}

func planTargets(data []byte) (map[Target]int, error) {
	if len(data) == 0 || len(data) > CaptureLimit {
		return nil, errors.New("immutable plan JSON missing or oversized")
	}
	var plan struct {
		Format   string `json:"format_version"`
		Version  string `json:"terraform_version"`
		Complete *bool  `json:"complete"`
		Errored  *bool  `json:"errored"`
		Values   struct {
			Root planModule `json:"root_module"`
		} `json:"planned_values"`
		Prior struct {
			Values struct {
				Root planModule `json:"root_module"`
			} `json:"values"`
		} `json:"prior_state"`
		Changes []struct {
			planResource
			Change struct {
				Actions []string `json:"actions"`
			} `json:"change"`
		} `json:"resource_changes"`
	}
	if json.Unmarshal(data, &plan) != nil || plan.Format != "1.2" || plan.Version != "1.17.1" || plan.Complete == nil || !*plan.Complete || plan.Errored == nil || *plan.Errored {
		return nil, errors.New("unsupported or incomplete saved plan")
	}
	out := map[Target]int{}
	changed := map[string]bool{}
	for _, r := range plan.Changes {
		if r.Mode == "data" {
			continue
		}
		if r.Mode != "managed" || r.Address == "" {
			return nil, errors.New("unsupported plan resource")
		}
		actions := r.Change.Actions
		if len(actions) == 2 {
			if !((actions[0] == "create" && actions[1] == "delete") || (actions[0] == "delete" && actions[1] == "create")) {
				return nil, errors.New("unsupported replacement action")
			}
		} else if len(actions) != 1 {
			return nil, errors.New("unsupported plan action count")
		}
		for _, action := range actions {
			operation := map[string]string{"create": "Create", "update": "Update", "delete": "Delete", "no-op": "NoOp"}[action]
			if operation == "" {
				return nil, fmt.Errorf("unsupported native plan operation %q", action)
			}
			out[Target{"resource", r.Address, operation}]++
		}
		changed[r.Address] = true
	}
	var visit func(planModule) error
	visit = func(module planModule) error {
		for _, r := range module.Resources {
			if r.Mode == "data" {
				continue
			}
			if r.Mode != "managed" || r.Address == "" {
				return errors.New("unsupported planned resource")
			}
			if !changed[r.Address] {
				out[Target{"resource", r.Address, "NoOp"}]++
				changed[r.Address] = true
			}
		}
		for _, child := range module.Children {
			if e := visit(child); e != nil {
				return e
			}
		}
		return nil
	}
	if e := visit(plan.Values.Root); e != nil {
		return nil, e
	}
	// Refresh-only archives omit resources from planned_values. Their refreshed
	// prior state independently identifies managed NoOp evaluations instead.
	if e := visit(plan.Prior.Values.Root); e != nil {
		return nil, e
	}
	return out, nil
}
