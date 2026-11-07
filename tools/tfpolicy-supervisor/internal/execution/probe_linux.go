//go:build linux

package execution

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"time"
)

// Probe performs the same pin/kernel/delegation checks before a worker obtains
// source or credentials. It never starts BYOB, providers or a Terraform run.
func probe(parent context.Context, c Config) error {
	if c.SchemaVersion != 1 {
		return errors.New("unsupported native runtime profile")
	}
	files := map[string]*os.File{}
	defer func() {
		for _, f := range files {
			f.Close()
		}
	}()
	for name, p := range map[string]PinnedFile{"engine": c.Runtime.Engine, "runner": c.Runtime.Runner, "supervisor": c.Runtime.Supervisor, "shim": c.Runtime.Shim, "recorder": c.Runtime.Recorder, "plugin": c.Runtime.Plugin} {
		f, e := openPinned(p, true)
		if e != nil {
			return e
		}
		files[name] = f
	}
	if e := readiness(files["runner"]); e != nil {
		return e
	}
	ctx, stop := context.WithTimeout(parent, 5*time.Second)
	defer stop()
	cmd := exec.CommandContext(ctx, "/proc/self/fd/3", "native-policy-contract")
	cmd.ExtraFiles = []*os.File{files["engine"]}
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	out, e := cmd.Output()
	var contract struct {
		ContractVersion  int    `json:"contractVersion"`
		TerraformVersion string `json:"terraformVersion"`
		Platform         string `json:"platform"`
		PatchSHA256      string `json:"patchSha256"`
	}
	if e != nil || strictJSON(out, &contract) != nil || contract.ContractVersion != 2 || contract.TerraformVersion != "1.17.1" || contract.PatchSHA256 != c.Runtime.PatchSHA256 || !validDigest(contract.PatchSHA256) {
		return errors.New("native runtime contract does not match the pinned engine")
	}
	f, e := newFence(c.CgroupRoot)
	if e != nil {
		return e
	}
	return f.close()
}
