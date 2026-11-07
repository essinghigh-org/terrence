package execution

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
)

// RuntimeIdentitySHA256 identifies verified bytes rather than installation
// paths. Each owner must still pin and open every actual executable.
func RuntimeIdentitySHA256(r Runtime) string {
	identity := map[string]string{"engine": r.Engine.SHA256, "runner": r.Runner.SHA256, "supervisor": r.Supervisor.SHA256, "shim": r.Shim.SHA256, "recorder": r.Recorder.SHA256, "plugin": r.Plugin.SHA256, "patchSha256": r.PatchSHA256, "entitlementCA": ""}
	if r.EntitlementCA != nil {
		identity["entitlementCA"] = r.EntitlementCA.SHA256
	}
	data, _ := json.Marshal(identity)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Snapshot hashing already binds root index, relative names and content. A
// receipt can therefore identify a policy without retaining a physical mount
// path that would prevent saved apply on another explicitly capable host.
func portablePolicyFile(roots []string, file string) (string, error) {
	for index, root := range roots {
		rel, err := filepath.Rel(root, file)
		if err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			return strconv.Itoa(index) + "/" + filepath.ToSlash(rel), nil
		}
	}
	return "", errors.New("native policy reference is outside its immutable source snapshot")
}
func portableOverrides(roots []string, overrides []Override) ([]Override, error) {
	out := make([]Override, 0, len(overrides))
	for _, override := range overrides {
		file, err := portablePolicyFile(roots, override.File)
		if err != nil {
			return nil, err
		}
		out = append(out, Override{file, override.Address})
	}
	return out, nil
}
