package recorder

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

type Config struct {
	SocketDirectory      string   `json:"socketDirectory"`
	SchemaVersion        int      `json:"schemaVersion"`
	PluginPath           string   `json:"pluginPath"`
	PluginSHA256         string   `json:"pluginSha256"`
	LandlockRunnerPath   string   `json:"landlockRunnerPath"`
	LandlockRunnerSHA256 string   `json:"landlockRunnerSha256"`
	PolicyReadRoots      []string `json:"policyReadRoots"`
	TemporaryDirectory   string   `json:"temporaryDirectory"`
}

func ReadConfig(r io.Reader) (Config, error) {
	var c Config
	d := json.NewDecoder(io.LimitReader(r, 65537))
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil {
		return c, errors.New("invalid recorder configuration")
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return c, errors.New("trailing recorder configuration")
	}
	if c.SchemaVersion != 1 || len(c.PolicyReadRoots) == 0 || len(c.PolicyReadRoots) > 1000 {
		return c, errors.New("unsupported recorder configuration")
	}
	if err := canonical(c.SocketDirectory); err != nil {
		return c, err
	}
	info, err := os.Stat(c.SocketDirectory)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 || len(c.SocketDirectory) > 60 {
		return c, errors.New("recorder socket directory must be private, canonical and short")
	}
	return c, nil
}
func canonical(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" || strings.ContainsAny(path, "\x00\n\r") {
		return errors.New("noncanonical recorder path")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return errors.New("recorder path contains a symlink or is missing")
	}
	return nil
}
func pinnedExecutable(path, sha string) error {
	if err := canonical(path); err != nil {
		return err
	}
	decoded, err := hex.DecodeString(sha)
	if err != nil || len(decoded) != 32 || strings.ToLower(sha) != sha {
		return errors.New("invalid executable digest")
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0222 != 0 || st.Mode().Perm()&0111 == 0 || st.Size() > 512*1024*1024 {
		return errors.New("executable must be immutable regular file")
	}
	if stat, ok := st.Sys().(*syscall.Stat_t); !ok || stat.Nlink != 1 {
		return errors.New("executable must not be hard linked")
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, io.LimitReader(f, 512*1024*1024+1)); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != sha {
		return errors.New("executable digest mismatch")
	}
	return nil
}
func immutableRoot(root string) error {
	if err := canonical(root); err != nil {
		return err
	}
	st, err := os.Stat(root)
	if err != nil || !st.IsDir() {
		return errors.New("policy root must be a directory")
	}
	count := 0
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		count++
		if count > 10000 {
			return errors.New("policy root contains too many entries")
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || (!info.Mode().IsRegular() && !info.IsDir()) || info.Mode().Perm()&0222 != 0 {
			return errors.New("policy root must be immutable without links or special files")
		}
		if stat, ok := info.Sys().(*syscall.Stat_t); !info.IsDir() && (!ok || stat.Nlink != 1) {
			return errors.New("policy root contains a hard link")
		}
		return nil
	})
}

// PrepareCommand always uses Landlock; no environment flag can disable confinement.
// The caller owns cleanup even when go-plugin exits via os.Exit.
func PrepareCommand(c Config) (*exec.Cmd, string, func(), error) {
	noop := func() {}
	if err := pinnedExecutable(c.PluginPath, c.PluginSHA256); err != nil {
		return nil, "", noop, err
	}
	if err := pinnedExecutable(c.LandlockRunnerPath, c.LandlockRunnerSHA256); err != nil {
		return nil, "", noop, err
	}
	if err := canonical(c.TemporaryDirectory); err != nil {
		return nil, "", noop, err
	}
	info, err := os.Stat(c.TemporaryDirectory)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return nil, "", noop, errors.New("temporary parent must be private 0700 directory")
	}
	for _, root := range c.PolicyReadRoots {
		if err := immutableRoot(root); err != nil {
			return nil, "", noop, err
		}
	}
	probe := exec.Command(c.LandlockRunnerPath, "--probe")
	probe.Env = []string{"PATH=/usr/bin:/bin"}
	output, err := probe.Output()
	abi, parseErr := strconv.Atoi(strings.TrimSpace(string(output)))
	// ABI 6 also scopes signals/abstract sockets, preventing the plugin from
	// signaling its less-restricted recorder or supervisor.
	if err != nil || parseErr != nil || abi < 6 {
		return nil, "", noop, errors.New("recorder requires Landlock ABI 6 or newer")
	}
	tmp, err := os.MkdirTemp(c.TemporaryDirectory, "plugin-")
	if err != nil {
		return nil, "", noop, err
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }
	if len(tmp) > 60 {
		cleanup()
		return nil, "", noop, errors.New("plugin temporary directory too long for Unix sockets")
	}
	args := []string{"--deny-debug", "--connect-unix=" + tmp, "--rw=" + tmp, "--rx=" + c.PluginPath}
	for _, root := range c.PolicyReadRoots {
		args = append(args, "--ro="+root)
	}
	// Fixed system trust roots only. Never expose /proc, a home directory,
	// the supervisor directory, workspace configuration, or host environment.
	seen := map[string]bool{}
	for _, path := range []string{"/usr/lib", "/lib", "/lib64"} {
		real, e := filepath.EvalSymlinks(path)
		if e == nil && !seen[real] {
			args = append(args, "--rx="+real)
			seen[real] = true
		}
	}
	for _, path := range []string{"/etc/ssl/certs", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ld.so.cache", "/dev/urandom", "/dev/random"} {
		real, e := filepath.EvalSymlinks(path)
		if e == nil {
			args = append(args, "--ro="+real)
		}
	}
	args = append(args, "--rw=/dev/null", "--cwd="+tmp, "--", c.PluginPath, "rpcapi")
	cmd := exec.Command(c.LandlockRunnerPath, args...)
	cmd.Dir = tmp
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + tmp, "TMPDIR=" + tmp}
	// Inherit the supervisor-owned process group so its kill covers every child.
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	// Deliberately no ExtraFiles: journal/config/executable descriptors never reach BYOB.
	return cmd, tmp, cleanup, nil
}
