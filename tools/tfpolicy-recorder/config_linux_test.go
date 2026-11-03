package recorder

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func immutableFile(t *testing.T, path, contents string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0555); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(contents))
	return hex.EncodeToString(sum[:])
}
func TestConfigurationRejectsUnknownFieldsAndTrailingData(t *testing.T) {
	for _, text := range []string{`{"schemaVersion":1,"policyReadRoots":["/policy"],"secret":"bad"}`, `{"schemaVersion":1,"policyReadRoots":["/policy"]} {}`, `{"schemaVersion":2,"policyReadRoots":["/policy"]}`, `{"schemaVersion":1,"policyReadRoots":[]}`} {
		if _, err := ReadConfig(strings.NewReader(text)); err == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
}
func TestPinnedExecutableAndImmutableRoots(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "plugin")
	sha := immutableFile(t, binary, "binary")
	if err := pinnedExecutable(binary, sha); err != nil {
		t.Fatal(err)
	}
	if err := pinnedExecutable(binary, strings.Repeat("0", 64)); err == nil {
		t.Fatal("hash mismatch accepted")
	}
	if err := os.Chmod(binary, 0755); err != nil {
		t.Fatal(err)
	}
	if err := pinnedExecutable(binary, sha); err == nil {
		t.Fatal("writable executable accepted")
	}
	root := filepath.Join(dir, "policy")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := immutableRoot(root); err == nil {
		t.Fatal("writable root accepted")
	}
	target := filepath.Join(root, "link")
	if err := os.Symlink(binary, target); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(root, 0500)
	if err := immutableRoot(root); err == nil {
		t.Fatal("link accepted")
	}
	_ = os.Chmod(root, 0700)
}
func TestSandboxCommandHasNoHostEnvironmentOrPrivateDescriptors(t *testing.T) {
	// A trusted probe fixture tests command construction only; it never substitutes
	// for a real confinement test and is never executed as the policy plugin.
	base, err := os.MkdirTemp("/tmp", "trc-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	root := filepath.Join(base, "p")
	_ = os.Mkdir(root, 0500)
	defer os.Chmod(root, 0700)
	binary := filepath.Join(base, "plugin")
	runner := filepath.Join(base, "runner")
	c := Config{SchemaVersion: 1, PluginPath: binary, PluginSHA256: immutableFile(t, binary, "plugin"), LandlockRunnerPath: runner, LandlockRunnerSHA256: immutableFile(t, runner, "#!/bin/sh\nprintf '6\\n'\n"), PolicyReadRoots: []string{root}, TemporaryDirectory: base}
	t.Setenv("SUPERVISOR_MAC_KEY", "not-in-child")
	t.Setenv("TFPOLICY_JOURNAL_FD", "3")
	t.Setenv("PLUGIN_CLIENT_CERT", "upstream-only")
	cmd, tmp, cleanup, err := PrepareCommand(c)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if len(cmd.ExtraFiles) != 0 || len(cmd.Env) != 3 {
		t.Fatal("private descriptor or env inheritance")
	}
	if strings.Contains(strings.Join(cmd.Env, "\n"), "not-in-child") || strings.Contains(strings.Join(cmd.Env, "\n"), "TFPOLICY") || strings.Contains(strings.Join(cmd.Env, "\n"), "PLUGIN_CLIENT_CERT") {
		t.Fatal("host env leaked")
	}
	args := strings.Join(cmd.Args, "\n")
	if !strings.Contains(args, "--rw="+tmp) || !strings.Contains(args, "--ro="+root) || strings.Contains(args, "--ro=/proc") {
		t.Fatal(args)
	}
	if cmd.SysProcAttr.Setpgid || cmd.SysProcAttr.Pdeathsig == 0 {
		t.Fatal("child escaped supervisor process group contract")
	}
}
