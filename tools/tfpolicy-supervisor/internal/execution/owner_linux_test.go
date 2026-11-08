//go:build linux

package execution

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOwnerRejectsTargetedPlansBeforeRuntimePreparation(t *testing.T) {
	for _, args := range [][]string{
		{"-target=terraform_data.proof"},
		{"-target", "terraform_data.proof"},
		{"--target=terraform_data.proof"},
		{"--target", "terraform_data.proof"},
		{"-refresh=false", "-target=module.child"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			c := Config{Command: "plan", Arguments: args}
			if _, err := commandArgs(c, "plan"); err == nil || !strings.Contains(err.Error(), "without -target") {
				t.Fatalf("targeted plan arguments did not produce an explicit rejection: %v", err)
			}
			// No paths or runtime pins are supplied: this must reject the mode
			// before configuration preparation or any executable is consulted.
			result, err := Execute(context.Background(), c)
			if err == nil || !strings.Contains(err.Error(), "without -target") {
				t.Fatalf("targeted plan reached runtime preparation: %v", err)
			}
			if result.Directory != "" || result.Verified || result.Receipt != nil || !result.CgroupEmpty {
				t.Fatalf("targeted plan created execution artifacts or admission: %+v", result)
			}
		})
	}
}

func TestOwnerPreservesSupportedPlanArguments(t *testing.T) {
	for _, arg := range []string{"-refresh=false", "-refresh=true", "-refresh-only", "-destroy", "-replace=terraform_data.proof", "-var-file=run.tfvars", "-parallelism=4"} {
		t.Run(arg, func(t *testing.T) {
			args, err := commandArgs(Config{Command: "plan", Arguments: []string{arg}}, "plan")
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, actual := range args {
				found = found || actual == arg
			}
			if !found {
				t.Fatalf("supported argument was omitted: %v", args)
			}
		})
	}
}

func TestOwnerRejectsRuntimeControlEnvironmentAndDirectApply(t *testing.T) {
	for _, key := range []string{"LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "GLIBC_TUNABLES", "GCONV_PATH", "TF_CLI_ARGS", "TF_POLICY_PLUGIN", "TFPOLICY_RECORDER_CONFIG"} {
		if _, e := engineEnv(Config{Environment: map[string]string{key: "injected"}}, "nonce", "socket"); e == nil {
			t.Fatalf("accepted runtime control %s", key)
		}
	}
	if _, e := commandArgs(Config{Command: "apply"}, "plan"); e == nil {
		t.Fatal("accepted direct apply")
	}
	for _, arg := range []string{"-strict-policy=false", "-policies=/workspace", "-out=/workspace/forged", "-chdir=/other", "-state=/private"} {
		if _, e := commandArgs(Config{Command: "plan", Arguments: []string{arg}}, "plan"); e == nil {
			t.Fatal("accepted owner control override", arg)
		}
	}
}

// Native qualification must explicitly provide a compiled original test fixture
// and real delegated cgroup. A skipped test is not a native qualification pass.
func TestNativeOwner(t *testing.T) {
	profile := os.Getenv("TFPOLICY_OWNER_TEST_PROFILE")
	if profile == "" {
		t.Skip("native owner qualification not requested")
	}
	data, e := os.ReadFile(profile)
	if e != nil {
		t.Fatal(e)
	}
	var base Config
	if e = strictJSON(data, &base); e != nil {
		t.Fatal(e)
	}
	for _, mode := range []string{"allow", "advisory", "override", "orphan", "apply-deny", "apply-crash", "apply-hang", "deny", "setup-error", "crash", "hang", "init-mandatory", "init-mandatory-reverse", "init-overridable", "init-overridable-reverse", "init-unknown"} {
		t.Run(mode, func(t *testing.T) {
			root, e := os.MkdirTemp("/tmp", "tfo-")
			if e != nil {
				t.Fatal(e)
			}
			t.Cleanup(func() { _ = os.RemoveAll(root) })
			t.Cleanup(func() {
				if t.Failed() {
					_ = filepath.WalkDir(root, func(path string, d os.DirEntry, e error) error {
						if e == nil && !d.IsDir() && (d.Name() == "stdout" || d.Name() == "stderr" || d.Name() == "audit" || d.Name() == "journal" || d.Name() == "plan.json") {
							b, _ := os.ReadFile(path)
							if len(b) > 32<<10 {
								b = b[:32<<10]
							}
							t.Log(path, string(b))
						}
						return nil
					})
				}
			})
			work, policies, private := filepath.Join(root, "w"), filepath.Join(root, "p"), filepath.Join(root, "s")
			if mode == "allow" {
				work = filepath.Join(root, strings.Repeat("long-workspace-", 12))
			}
			for _, p := range []string{work, policies, private} {
				if e = os.Mkdir(p, 0700); e != nil {
					t.Fatal(e)
				}
			}
			if e = os.WriteFile(filepath.Join(private, "canary"), []byte("never expose owner files"), 0600); e != nil {
				t.Fatal(e)
			}
			if e = os.WriteFile(filepath.Join(work, "main.tf"), []byte(`resource "terraform_data" "proof" { input = "local-only" }`), 0600); e != nil {
				t.Fatal(e)
			}
			fixtureMode, enforcement := mode, "mandatory"
			if mode == "advisory" {
				fixtureMode = "deny"
				enforcement = "advisory"
			}
			if mode == "override" {
				fixtureMode = "deny"
				enforcement = "mandatory_overridable"
			}
			if strings.HasPrefix(mode, "init-") {
				if strings.HasPrefix(mode, "init-overridable") {
					enforcement = "mandatory_overridable"
				}
				if e = os.Mkdir(filepath.Join(work, "child"), 0700); e != nil {
					t.Fatal(e)
				}
				if e = os.WriteFile(filepath.Join(work, "child", "main.tf"), []byte("# local module policy fixture\n"), 0600); e != nil {
					t.Fatal(e)
				}
				f, e := os.OpenFile(filepath.Join(work, "main.tf"), os.O_APPEND|os.O_WRONLY, 0600)
				if e != nil {
					t.Fatal(e)
				}
				_, e = f.WriteString("\nmodule \"child\" { source = \"./child\" }\n")
				f.Close()
				if e != nil {
					t.Fatal(e)
				}
			}
			fixture, _ := json.Marshal(map[string]any{"mode": fixtureMode, "enforcement": enforcement, "require_context": true, "forbidden_path": filepath.Join(private, "canary")})
			if e = os.WriteFile(filepath.Join(policies, "fixture.json"), fixture, 0400); e != nil {
				t.Fatal(e)
			}
			if e = os.WriteFile(filepath.Join(policies, "fixture.policy.hcl"), []byte("# original test-only transport fixture\n"), 0400); e != nil {
				t.Fatal(e)
			}
			if e = os.Chmod(policies, 0500); e != nil {
				t.Fatal(e)
			}
			defer os.Chmod(policies, 0700)
			c := base
			c.RunID = "run-native-owner"
			c.WorkspaceID = "ws-native-owner"
			c.WorkDirectory = work
			c.PrivateParent = private
			c.PolicyRoots = []string{policies}
			c.TimeoutSeconds = 20
			c.Command = "init"
			c.ReceiptKey = strings.Repeat("d", 64)
			c.EvaluationID = "eval-native-owner"
			c.PolicyFingerprint = strings.Repeat("e", 64)
			c.RunContext = &RunContext{Host: "terrence.example", Organization: "owner-tests", Token: "private-run-token"}
			if mode == "override" {
				c.Overrides = []Override{{filepath.Join(policies, "fixture.policy.hcl"), "fixture.integration"}}
			}
			// Setup failure is exercised during strict init; other modes fail only
			// during resource evaluation, after a successful audited initialization.
			init, e := Execute(context.Background(), c)
			if strings.HasPrefix(mode, "init-") {
				allowed := mode == "init-unknown"
				if allowed && (e != nil || !init.Verified || !init.Evidence.Allows || init.ExitCode != 0) {
					t.Fatal("pure unknown was not deferred at init", init, e)
				}
				if !allowed && (e != nil || !init.Verified || init.Evidence.Allows || init.ExitCode == 0 || !init.CgroupEmpty) {
					t.Fatal("mixed required denial/unknown passed init", init, e)
				}
				known, unknown := false, false
				for _, p := range init.Evidence.Policies {
					known = known || p.Result == "DenyResult"
					unknown = unknown || p.Result == "UnknownResult"
				}
				if !unknown || !allowed && !known {
					t.Fatal("init fixture did not reach the required policy results", init)
				}
				return
			}
			if mode == "setup-error" {
				if e == nil || init.Verified || init.Evidence.Allows || !init.CgroupEmpty {
					t.Fatal("Setup failure was not fenced", init, e)
				}
				return
			}
			if e != nil || !init.Verified || !init.Evidence.Allows {
				t.Fatal("strict init failed", init, e)
			}
			c.Command = "plan"
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			type outcome struct {
				r Result
				e error
			}
			done := make(chan outcome, 1)
			go func() { r, e := Execute(ctx, c); done <- outcome{r, e} }()
			if mode == "hang" {
				deadline := time.Now().Add(10 * time.Second)
				observed := false
				for time.Now().Before(deadline) {
					paths, _ := filepath.Glob(filepath.Join(private, "r-*", "journal"))
					for _, p := range paths {
						b, _ := os.ReadFile(p)
						if strings.Contains(string(b), `"method":"EvaluateResource","phase":"begin"`) {
							observed = true
							break
						}
					}
					if observed {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
				if !observed {
					cancel()
					got := <-done
					t.Fatal("cancellation did not reach an in-flight RPC", got.r, got.e)
				}
				cancel()
			}
			got := <-done
			if !got.r.CgroupEmpty {
				t.Fatal("process tree not empty", got.r, got.e)
			}
			if mode == "allow" || mode == "advisory" || mode == "override" || mode == "orphan" || strings.HasPrefix(mode, "apply-") {
				if got.e != nil || !got.r.Verified || !got.r.Evidence.Allows || got.r.ExitCode != 2 || got.r.Evidence.Targets < 2 {
					t.Fatal("allow plan failed", got.r, got.e)
				}
				c.Command = "apply"
				c.SavedPlan = &PinnedFile{filepath.Join(got.r.Directory, "tfplan"), got.r.PlanSHA256}
				c.PlanReceipt = got.r.Receipt
				var applied Result
				if mode == "apply-hang" {
					applyCtx, applyCancel := context.WithCancel(context.Background())
					defer applyCancel()
					applyDone := make(chan outcome, 1)
					go func() { r, e := Execute(applyCtx, c); applyDone <- outcome{r, e} }()
					deadline := time.Now().Add(10 * time.Second)
					observed := false
					for time.Now().Before(deadline) {
						paths, _ := filepath.Glob(filepath.Join(private, "r-*", "audit"))
						for _, p := range paths {
							b, _ := os.ReadFile(p)
							if strings.Contains(string(b), `"command":"apply"`) {
								journal, _ := os.ReadFile(filepath.Join(filepath.Dir(p), "journal"))
								if strings.Contains(string(journal), `"method":"EvaluateResource","phase":"begin"`) {
									observed = true
									break
								}
							}
						}
						if observed {
							break
						}
						time.Sleep(10 * time.Millisecond)
					}
					applyCancel()
					out := <-applyDone
					applied, e = out.r, out.e
					if !observed {
						t.Fatal("apply cancellation never reached resource RPC", applied, e)
					}
				} else {
					applied, e = Execute(context.Background(), c)
				}
				if strings.HasPrefix(mode, "apply-") {
					if applied.Evidence.Allows || !applied.CgroupEmpty {
						t.Fatal("post-apply failure authorized or leaked processes", applied, e)
					}
					if mode == "apply-deny" && (e != nil || !applied.Verified || applied.ExitCode != 1) {
						t.Fatal("post-apply denial lost native evidence", applied, e)
					}
					if mode == "apply-hang" && !applied.Cancelled {
						t.Fatal("post-apply cancellation missing", applied, e)
					}
					state, err := os.ReadFile(filepath.Join(work, "terraform.tfstate"))
					if err != nil || !strings.Contains(string(state), `"instances"`) {
						t.Fatal("post-apply failure lost actual state", applied, e, err)
					}
					return
				}
				if e != nil || !applied.Verified || !applied.Evidence.Allows || !applied.CgroupEmpty {
					t.Fatal("saved-plan apply failed", applied, e)
				}
				if _, e = os.Stat(filepath.Join(work, "terraform.tfstate")); e != nil {
					t.Fatal("actual apply state missing", e)
				}
				if mode == "allow" {
					for _, args := range [][]string{nil, {"-refresh-only"}, {"-replace=terraform_data.proof"}, {"-destroy"}} {
						c.Command = "plan"
						c.Arguments = args
						c.SavedPlan = nil
						next, e := Execute(context.Background(), c)
						if e != nil || !next.Verified || !next.Evidence.Allows {
							t.Fatal("plan action coverage failed", args, next, e)
						}
						if len(args) > 0 && args[0] != "-refresh-only" {
							c.Command = "apply"
							c.Arguments = nil
							c.SavedPlan = &PinnedFile{filepath.Join(next.Directory, "tfplan"), next.PlanSHA256}
							c.PlanReceipt = next.Receipt
							updated, e := Execute(context.Background(), c)
							if e != nil || !updated.Verified || !updated.Evidence.Allows {
								t.Fatal("saved-plan action coverage failed", args, updated, e)
							}
						}
					}
				}
			} else {
				if got.r.Verified && got.r.Evidence.Allows || got.r.ExitCode == 0 {
					t.Fatal("negative stage authorized", got.r, got.e)
				}
				if mode == "deny" && (got.e != nil || !got.r.Verified || got.r.Evidence.Allows || got.r.ExitCode != 1) {
					t.Fatal("denial lost verified policy result", got.r, got.e)
				}
				if mode == "deny" {
					c.Command = "apply"
					c.SavedPlan = &PinnedFile{filepath.Join(got.r.Directory, "tfplan"), got.r.PlanSHA256}
					c.PlanReceipt = got.r.Receipt
					rejected, e := Execute(context.Background(), c)
					if e == nil || rejected.Verified || !rejected.CgroupEmpty {
						t.Fatal("denied saved plan was not rejected before execution", rejected, e)
					}
				}
				if mode == "hang" && !got.r.Cancelled {
					t.Fatal("cancellation outcome missing", got.r, got.e)
				}
				if b, e := os.ReadFile(filepath.Join(work, "terraform.tfstate")); e == nil && strings.Contains(string(b), `"instances"`) {
					t.Fatal("negative plan mutated resources")
				}
			}
		})
	}
}
