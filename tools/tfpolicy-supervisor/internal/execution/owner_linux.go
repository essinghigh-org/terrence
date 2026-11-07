//go:build linux

package execution

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"terrence.tools/tfpolicy-supervisor/internal/bootstrap"
	"time"
)

func LoadConfig(path string) (Config, error) {
	var c Config
	f, e := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if e != nil {
		return c, errors.New("cannot open private owner configuration")
	}
	defer f.Close()
	s, e := f.Stat()
	st, ok := safestat(s)
	if e != nil || !ok || !s.Mode().IsRegular() || s.Mode().Perm()&0077 != 0 || st.Uid != uint32(os.Getuid()) || st.Nlink != 1 || s.Size() > 1<<20 {
		return c, errors.New("owner configuration must be a bounded private regular file")
	}
	data, e := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if e != nil || strictJSON(data, &c) != nil {
		return c, errors.New("invalid owner configuration")
	}
	return c, nil
}
func safestat(s os.FileInfo) (*syscall.Stat_t, bool) {
	if s == nil {
		return nil, false
	}
	st, ok := s.Sys().(*syscall.Stat_t)
	return st, ok
}
func canonical(path string) bool {
	real, e := filepath.EvalSymlinks(path)
	return e == nil && real == path && filepath.IsAbs(path) && filepath.Clean(path) == path && path != "/" && !strings.ContainsAny(path, "\x00\r\n")
}
func within(root, path string) bool {
	r, e := filepath.Rel(root, path)
	return e == nil && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) && !filepath.IsAbs(r)
}
func privateDir(path string) bool {
	s, e := os.Stat(path)
	st, ok := safestat(s)
	return e == nil && ok && canonical(path) && s.IsDir() && s.Mode().Perm() == 0700 && st.Uid == uint32(os.Getuid())
}
func openPinned(p PinnedFile, executable bool) (*os.File, error) {
	if !canonical(p.Path) || !validDigest(p.SHA256) {
		return nil, errors.New("invalid pinned runtime identity")
	}
	f, e := os.OpenFile(p.Path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if e != nil {
		return nil, e
	}
	s, e := f.Stat()
	st, ok := safestat(s)
	if e != nil || !ok || !s.Mode().IsRegular() || s.Mode().Perm()&0222 != 0 || executable && s.Mode().Perm()&0111 == 0 || st.Nlink != 1 || s.Size() > 512<<20 {
		f.Close()
		return nil, errors.New("pinned artifact must be immutable, regular and unlinked")
	}
	if e = bootstrap.CheckPinned(f, p.SHA256); e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
func immutablePolicy(root string) error {
	if !canonical(root) {
		return errors.New("invalid policy snapshot path")
	}
	if s, e := os.Stat(root); e != nil || !s.IsDir() {
		return errors.New("policy snapshot root must be a directory")
	}
	count := 0
	size := int64(0)
	return filepath.WalkDir(root, func(path string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		s, e := d.Info()
		st, ok := safestat(s)
		if e != nil || !ok {
			return errors.New("unverifiable policy snapshot entry")
		}
		count++
		size += s.Size()
		if count > 10000 || size > 20<<20 || s.Mode().Perm()&0222 != 0 || !s.Mode().IsRegular() && !s.IsDir() || !s.IsDir() && st.Nlink != 1 {
			return errors.New("policy snapshot must be immutable, bounded and without links")
		}
		return nil
	})
}

func snapshotDigest(roots []string) (string, error) {
	h := sha256.New()
	entries := 0
	total := int64(0)
	for index, root := range roots {
		if e := immutablePolicy(root); e != nil {
			return "", e
		}
		e := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			entries++
			if entries > 10000 {
				return errors.New("policy snapshot entry limit exceeded")
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			sum := "directory"
			if !d.IsDir() {
				f, e := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
				if e != nil {
					return e
				}
				defer f.Close()
				s, e := f.Stat()
				st, ok := safestat(s)
				if e != nil || !ok || !s.Mode().IsRegular() || st.Nlink != 1 || s.Mode().Perm()&0222 != 0 {
					return errors.New("policy snapshot changed during capture")
				}
				digest := sha256.New()
				n, e := io.Copy(digest, io.LimitReader(f, (20<<20)+1))
				if e != nil {
					return e
				}
				total += n
				if n != s.Size() || total > 20<<20 {
					return errors.New("policy snapshot content limit exceeded")
				}
				sum = hex.EncodeToString(digest.Sum(nil))
			}
			return json.NewEncoder(h).Encode(struct {
				Root       int
				Path, Hash string
			}{index, filepath.ToSlash(rel), sum})
		})
		if e != nil {
			return "", e
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func readiness(runner *os.File) error {
	if os.Getuid() == 0 || os.Geteuid() == 0 {
		return errors.New("native policy owner must be unprivileged")
	}
	status, e := os.ReadFile("/proc/self/status")
	if e != nil {
		return e
	}
	caps := 0
	for _, line := range strings.Split(string(status), "\n") {
		for _, key := range []string{"CapEff:", "CapPrm:", "CapInh:", "CapAmb:"} {
			if strings.HasPrefix(line, key) {
				n, e := strconv.ParseUint(strings.TrimSpace(strings.TrimPrefix(line, key)), 16, 64)
				if e != nil || n != 0 {
					return errors.New("native policy owner requires zero process capabilities")
				}
				caps++
			}
		}
	}
	if caps != 4 {
		return errors.New("cannot verify process capabilities")
	}
	core, e := os.ReadFile("/proc/sys/kernel/core_pattern")
	if e != nil || strings.TrimSpace(string(core)) == "" || strings.HasPrefix(strings.TrimSpace(string(core)), "|") {
		return errors.New("native policy owner requires a verifiable non-piped core handler")
	}
	var fs syscall.Statfs_t
	if syscall.Statfs("/proc/self", &fs) != nil || fs.Type != 0x9fa0 {
		return errors.New("native policy owner requires trusted procfs")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/proc/self/fd/3", "--probe")
	cmd.ExtraFiles = []*os.File{runner}
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	out, e := cmd.Output()
	n, parse := strconv.Atoi(strings.TrimSpace(string(out)))
	if e != nil || parse != nil || n < 6 {
		return errors.New("native policy owner requires Landlock ABI 6 or newer")
	}
	return nil
}

type fence struct {
	path   string
	closed bool
}

func newFence(root string) (*fence, error) {
	var fs syscall.Statfs_t
	if !canonical(root) || syscall.Statfs(root, &fs) != nil || fs.Type != 0x63677270 {
		return nil, errors.New("real delegated cgroup v2 is required")
	}
	controllers, e := os.ReadFile(filepath.Join(root, "cgroup.subtree_control"))
	if e != nil {
		return nil, e
	}
	s := " " + strings.TrimSpace(string(controllers)) + " "
	if !strings.Contains(s, " pids ") || !strings.Contains(s, " memory ") {
		return nil, errors.New("pids and memory controllers must already be delegated")
	}
	name := make([]byte, 12)
	if _, e = rand.Read(name); e != nil {
		return nil, e
	}
	path := filepath.Join(root, "tfpolicy-"+hex.EncodeToString(name))
	if e = os.Mkdir(path, 0700); e != nil {
		return nil, e
	}
	f := &fence{path: path}
	for name, value := range map[string]string{"pids.max": "256", "memory.max": "2147483648"} {
		p := filepath.Join(path, name)
		if e = os.WriteFile(p, []byte(value), 0600); e != nil {
			f.close()
			return nil, e
		}
		b, e := os.ReadFile(p)
		if e != nil || strings.TrimSpace(string(b)) != value {
			f.close()
			return nil, errors.New("finite cgroup limit was not enforced")
		}
	}
	if _, e = os.Stat(filepath.Join(path, "cgroup.kill")); e != nil {
		f.close()
		return nil, e
	}
	return f, nil
}
func (f *fence) attach(p *os.Process) error {
	if e := os.WriteFile(filepath.Join(f.path, "cgroup.procs"), []byte(strconv.Itoa(p.Pid)), 0600); e != nil {
		return e
	}
	b, e := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", p.Pid))
	if e != nil || !strings.Contains(string(b), strings.TrimPrefix(f.path, "/sys/fs/cgroup")+"\n") {
		return errors.New("child cgroup attachment was not verified")
	}
	return nil
}
func (f *fence) close() error {
	if f.closed {
		return nil
	}
	if e := os.WriteFile(filepath.Join(f.path, "cgroup.kill"), []byte("1"), 0600); e != nil {
		return e
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		b, e := os.ReadFile(filepath.Join(f.path, "cgroup.events"))
		if e != nil {
			return e
		}
		if strings.Contains(string(b), "populated 0") {
			break
		}
		if time.Now().After(deadline) {
			return errors.New("native process tree remained populated after kill")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if e := os.Remove(f.path); e != nil {
		return e
	}
	f.closed = true
	return nil
}

type capture struct {
	sync.Mutex
	file   *os.File
	n      int64
	failed bool
	cancel context.CancelFunc
}

func newCapture(path string, cancel context.CancelFunc) (*capture, error) {
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	return &capture{file: f, cancel: cancel}, e
}
func (c *capture) Write(b []byte) (int, error) {
	c.Lock()
	defer c.Unlock()
	if c.n+int64(len(b)) > CaptureLimit {
		c.failed = true
		c.cancel()
		return 0, errors.New("native output capture limit exceeded")
	}
	n, e := c.file.Write(b)
	c.n += int64(n)
	if e != nil {
		c.failed = true
		c.cancel()
	}
	return n, e
}
func (c *capture) close() error {
	c.Lock()
	defer c.Unlock()
	if c.failed {
		return errors.Join(errors.New("native output capture failed"), c.file.Close())
	}
	return errors.Join(c.file.Sync(), c.file.Close())
}

func writePrivate(path string, value any) error {
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	if e = json.NewEncoder(f).Encode(value); e != nil {
		return e
	}
	return f.Sync()
}
func hashFile(path string) (string, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer f.Close()
	h := sha256.New()
	if _, e = io.Copy(h, f); e != nil {
		return "", e
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func processIdentity(pid int) (uint64, error) {
	b, e := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if e != nil {
		return 0, e
	}
	_, start, e := bootstrap.ParseStat(string(b))
	return start, e
}

// Begin reaping immediately, including failures while a child is still gated.
// Closing done publishes err and permits any number of bounded cleanup waits.
type childWait struct {
	done chan struct{}
	err  error
	cmd  *exec.Cmd
}

func reap(cmd *exec.Cmd) *childWait {
	w := &childWait{done: make(chan struct{}), cmd: cmd}
	go func() { w.err = cmd.Wait(); close(w.done) }()
	return w
}
func (w *childWait) cleanup() error {
	_ = w.cmd.Process.Kill()
	select {
	case <-w.done:
		return nil
	case <-time.After(3 * time.Second):
		return errors.New("native child did not reap after termination")
	}
}
func waitGate(ctx context.Context, p *os.Process, runnerPath string) (uint64, error) {
	for {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		default:
		}
		path, e := os.Readlink(fmt.Sprintf("/proc/%d/exe", p.Pid))
		if e == nil && path == runnerPath {
			return processIdentity(p.Pid)
		}
		if os.IsNotExist(e) {
			return 0, errors.New("engine exited before execution gate")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
func engineEnv(c Config, nonce, socket string) ([]string, error) {
	temporary := c.engineTemp
	if temporary == "" {
		temporary = c.WorkDirectory
	}
	env := []string{"PATH=/usr/bin:/bin", "HOME=" + c.WorkDirectory, "TMPDIR=" + temporary, "TF_IN_AUTOMATION=1", "CHECKPOINT_DISABLE=1", "TF_INPUT=0"}
	for k, v := range c.Environment {
		if k == "TF_CLI_CONFIG_FILE" {
			root := c.WorkRoot
			if root == "" {
				root = c.WorkDirectory
			}
			if !canonical(v) || !within(root, v) {
				return nil, errors.New("native CLI credentials must be inside the run workspace")
			}
			env = append(env, k+"="+v)
			continue
		}
		if k == "TF_LOG" {
			if !map[string]bool{"TRACE": true, "DEBUG": true, "INFO": true, "WARN": true, "ERROR": true, "OFF": true}[v] {
				return nil, errors.New("invalid native debug level")
			}
			env = append(env, k+"="+v)
			continue
		}
		if k == "" || strings.ContainsAny(k, "=\x00\r\n") || strings.ContainsRune(v, '\x00') {
			return nil, errors.New("invalid run environment")
		}
		if strings.HasPrefix(k, "LD_") || strings.HasPrefix(k, "DYLD_") || strings.HasPrefix(k, "GLIBC_") || strings.HasPrefix(k, "MALLOC_") || k == "GCONV_PATH" || k == "LOCPATH" || k == "NLSPATH" || strings.HasPrefix(k, "TF_") && !strings.HasPrefix(k, "TF_VAR_") || strings.HasPrefix(k, "TFPOLICY") {
			return nil, errors.New("run environment contains a native runtime control")
		}
		if k != "PATH" && k != "HOME" && k != "TMPDIR" && k != "CHECKPOINT_DISABLE" {
			env = append(env, k+"="+v)
		}
	}
	env = append(env, "TF_POLICY_PLUGIN="+c.Runtime.Shim.Path, "TFPOLICY_SUPERVISOR_SOCKET="+socket, "TF_POLICY_AUDIT_FD=3", "TF_POLICY_AUDIT_NONCE="+nonce)
	if c.Command == "plan" {
		env = append(env, "TF_POLICY_PLAN_FD=4")
	}
	if len(c.Overrides) > 0 {
		b, e := json.Marshal(c.Overrides)
		if e != nil {
			return nil, e
		}
		env = append(env, "TF_POLICY_AUDIT_OVERRIDES="+string(b))
	}
	return env, nil
}
func sandboxArgs(c Config, plan string, show bool) []string {
	root := c.WorkRoot
	if root == "" {
		root = c.WorkDirectory
	}
	args := []string{"--deny-debug", "--gate-stdin", "--rwx=" + root, "--rx=" + c.Runtime.Engine.Path, "--rx=" + c.Runtime.Shim.Path}
	if show {
		args[2] = "--rx=" + root
	}
	if c.engineTemp != "" {
		args = append(args, "--rwx="+c.engineTemp)
	}
	for _, root := range c.PolicyRoots {
		args = append(args, "--ro="+root)
	}
	if plan != "" && (c.Command != "plan" || show) {
		args = append(args, "--ro="+plan)
	}
	seen := map[string]bool{}
	for _, path := range []string{"/usr/lib", "/lib", "/lib64", "/usr/bin", "/bin"} {
		real, e := filepath.EvalSymlinks(path)
		if e == nil && !seen[real] {
			args = append(args, "--rx="+real)
			seen[real] = true
		}
	}
	for _, path := range []string{"/etc/ssl/certs", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ld.so.cache", "/dev/urandom", "/dev/random"} {
		if real, e := filepath.EvalSymlinks(path); e == nil {
			args = append(args, "--ro="+real)
		}
	}
	return append(args, "--rw=/dev/null", "--cwd="+c.WorkDirectory)
}
func commandArgs(c Config, plan string) ([]string, error) {
	if c.Command != "init" && c.Command != "plan" && c.Command != "apply" {
		return nil, errors.New("unsupported native command")
	}
	args := []string{c.Command, "-strict-policy", "-json", "-input=false", "-no-color"}
	for _, root := range c.PolicyRoots {
		args = append(args, "-policies="+root)
	}
	for _, arg := range c.Arguments {
		valid := c.Command == "plan" && (arg == "-refresh=false" || arg == "-refresh=true" || arg == "-refresh-only" || arg == "-destroy")
		for _, prefix := range []string{"-target=", "-replace=", "-var-file=", "-parallelism="} {
			if strings.HasPrefix(arg, prefix) && c.Command == "plan" && len(arg) > len(prefix) && !strings.ContainsAny(arg, "\x00\r\n") {
				valid = true
			}
		}
		if !valid {
			return nil, errors.New("unsupported owner command argument")
		}
		args = append(args, arg)
	}
	switch c.Command {
	case "init":
		args = append(args, "-reconfigure")
	case "plan":
		args = append(args, "-out="+plan, "-detailed-exitcode")
	case "apply":
		if c.SavedPlan == nil {
			return nil, errors.New("native apply requires an immutable saved plan")
		}
		args = append(args, "-auto-approve", plan)
	}
	return args, nil
}

func execute(parent context.Context, c Config) (result Result, retErr error) {
	if c.WorkRoot == "" {
		c.WorkRoot = c.WorkDirectory
	}
	result = Result{SchemaVersion: 1, RunID: c.RunID, WorkspaceID: c.WorkspaceID, Command: c.Command, ExitCode: -1, CgroupEmpty: true}
	defer func() {
		if !result.Verified {
			result.Receipt = nil
		}
		if retErr != nil {
			result.Verified = false
			result.Evidence = Evidence{}
			result.Receipt = nil
		}
	}()
	if c.SchemaVersion != 1 || c.RunID == "" || c.WorkspaceID == "" || c.TimeoutSeconds < 1 || c.TimeoutSeconds > 86400 || !canonical(c.WorkRoot) || !canonical(c.WorkDirectory) || !within(c.WorkRoot, c.WorkDirectory) || !privateDir(c.PrivateParent) || len(c.PrivateParent) > 25 || len(c.PolicyRoots) == 0 {
		return result, errors.New("invalid native owner configuration")
	}
	if _, e := receiptKey(c.ReceiptKey); e != nil || c.EvaluationID == "" || !validDigest(c.PolicyFingerprint) {
		return result, errors.New("native execution requires a private authenticated evaluation context")
	}
	if within(c.WorkRoot, c.PrivateParent) || within(c.PrivateParent, c.WorkRoot) {
		return result, errors.New("private owner storage overlaps workspace")
	}
	for _, root := range c.PolicyRoots {
		if within(c.WorkRoot, root) || within(root, c.WorkRoot) {
			return result, errors.New("policy snapshot overlaps workspace")
		}
		if e := immutablePolicy(root); e != nil {
			return result, e
		}
	}
	snapshot, e := snapshotDigest(c.PolicyRoots)
	if e != nil {
		return result, e
	}
	result.PolicySnapshotSHA256 = snapshot
	result.RuntimeSHA256 = RuntimeIdentitySHA256(c.Runtime)
	opened := map[string]*os.File{}
	defer func() {
		for _, f := range opened {
			f.Close()
		}
	}()
	for name, p := range map[string]PinnedFile{"engine": c.Runtime.Engine, "runner": c.Runtime.Runner, "supervisor": c.Runtime.Supervisor, "shim": c.Runtime.Shim, "recorder": c.Runtime.Recorder, "plugin": c.Runtime.Plugin} {
		if within(c.WorkRoot, p.Path) {
			return result, errors.New("runtime artifact overlaps workspace")
		}
		f, e := openPinned(p, true)
		if e != nil {
			return result, fmt.Errorf("invalid %s artifact: %w", name, e)
		}
		opened[name] = f
	}
	if e := readiness(opened["runner"]); e != nil {
		return result, e
	}
	if c.Runtime.EntitlementCA != nil {
		if within(c.WorkRoot, c.Runtime.EntitlementCA.Path) {
			return result, errors.New("entitlement CA overlaps workspace")
		}
		f, e := openPinned(*c.Runtime.EntitlementCA, false)
		if e != nil {
			return result, e
		}
		f.Close()
	}
	contractCtx, contractStop := context.WithTimeout(parent, 5*time.Second)
	defer contractStop()
	probe := exec.CommandContext(contractCtx, "/proc/self/fd/3", "native-policy-contract")
	probe.ExtraFiles = []*os.File{opened["engine"]}
	probe.Env = []string{"PATH=/usr/bin:/bin"}
	raw, e := probe.Output()
	var contract struct {
		ContractVersion  int    `json:"contractVersion"`
		TerraformVersion string `json:"terraformVersion"`
		Platform         string `json:"platform"`
		PatchSHA256      string `json:"patchSha256"`
	}
	if e != nil || strictJSON(raw, &contract) != nil || contract.ContractVersion != 2 || contract.TerraformVersion != "1.17.1" || contract.PatchSHA256 != c.Runtime.PatchSHA256 || !validDigest(contract.PatchSHA256) {
		return result, errors.New("pinned engine does not implement the required native policy contract")
	}
	nonce := make([]byte, 32)
	if _, e = rand.Read(nonce); e != nil {
		return result, e
	}
	result.Nonce = hex.EncodeToString(nonce)
	dir, e := os.MkdirTemp(c.PrivateParent, "r-")
	if e != nil {
		return result, e
	}
	result.Directory = dir
	socketDir, tmpDir := filepath.Join(dir, "u"), filepath.Join(dir, "t")
	// go-plugin callback sockets must fit Unix path limits even for a long
	// workspace path. This writable engine scratch never contains owner data
	// and is distinct from the recorder/plugin temporary directory.
	c.engineTemp = filepath.Join(dir, "w")
	for _, p := range []string{socketDir, tmpDir, c.engineTemp} {
		if e = os.Mkdir(p, 0700); e != nil {
			return result, e
		}
	}
	plan := ""
	switch c.Command {
	case "plan":
		plan = filepath.Join(dir, "tfplan")
	case "apply":
		if c.SavedPlan == nil {
			return result, errors.New("saved-plan apply requires a pinned plan")
		}
		if within(c.WorkRoot, c.SavedPlan.Path) {
			return result, errors.New("saved plan must be outside workspace writes")
		}
		f, e := openPinned(*c.SavedPlan, false)
		if e != nil {
			return result, e
		}
		f.Close()
		plan = c.SavedPlan.Path
		if e = authorizeApply(c, result); e != nil {
			return result, e
		}
	}
	args, e := commandArgs(c, plan)
	if e != nil {
		return result, e
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(c.TimeoutSeconds)*time.Second)
	defer cancel()
	group, e := newFence(c.CgroupRoot)
	if e != nil {
		return result, e
	}
	result.CgroupEmpty = false
	defer func() {
		if e := group.close(); e != nil {
			retErr = errors.Join(retErr, e)
			result.Verified = false
			result.Evidence = Evidence{}
		} else {
			result.CgroupEmpty = true
		}
		if parent.Err() != nil {
			result.Cancelled = true
			result.Verified = false
			result.Evidence = Evidence{}
		}
	}()
	stdout, e := newCapture(filepath.Join(dir, "stdout"), cancel)
	if e != nil {
		return result, e
	}
	defer func() { retErr = errors.Join(retErr, stdout.close()) }()
	stderr, e := newCapture(filepath.Join(dir, "stderr"), cancel)
	if e != nil {
		return result, e
	}
	defer func() { retErr = errors.Join(retErr, stderr.close()) }()
	audit, e := newCapture(filepath.Join(dir, "audit"), cancel)
	if e != nil {
		return result, e
	}
	defer func() { retErr = errors.Join(retErr, audit.close()) }()
	ar, aw, e := os.Pipe()
	if e != nil {
		return result, e
	}
	defer ar.Close()
	defer aw.Close()
	auditDone := make(chan error, 1)
	go func() { _, e := io.Copy(audit, ar); auditDone <- e }()
	planDescriptor, e := os.Open("/dev/null")
	if e != nil {
		return result, e
	}
	defer planDescriptor.Close()
	var planDone chan error
	if c.Command == "plan" {
		planCapture, e := newCapture(plan, cancel)
		if e != nil {
			return result, e
		}
		defer func() { retErr = errors.Join(retErr, planCapture.close()) }()
		pr, pw, e := os.Pipe()
		if e != nil {
			return result, e
		}
		defer pr.Close()
		defer pw.Close()
		planDescriptor = pw
		planDone = make(chan error, 1)
		go func() { _, e := io.Copy(planCapture, pr); planDone <- e }()
	}
	socket := filepath.Join(dir, "boot.sock")
	env, e := engineEnv(c, result.Nonce, socket)
	if e != nil {
		return result, e
	}
	engineArgs := sandboxArgs(c, plan, false)
	engineArgs = append(engineArgs, "--connect-unix="+dir, "--connect-unix="+socketDir, "--", "/proc/self/fd/5")
	engineArgs = append(engineArgs, args...)
	engine := exec.Command("/proc/self/fd/6", engineArgs...)
	engine.ExtraFiles = []*os.File{aw, planDescriptor, opened["engine"], opened["runner"]}
	engine.Env = env
	engine.Dir = c.WorkDirectory
	engine.Stdout = stdout
	engine.Stderr = stderr
	engine.WaitDelay = time.Second
	engine.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	gate, e := engine.StdinPipe()
	if e != nil {
		return result, e
	}
	defer gate.Close()
	if e = engine.Start(); e != nil {
		return result, e
	}
	engineWait := reap(engine)
	defer func() { retErr = errors.Join(retErr, engineWait.cleanup()) }()
	aw.Close()
	planDescriptor.Close()
	if e = group.attach(engine.Process); e != nil {
		return result, e
	}
	gateCtx, gateStop := context.WithTimeout(ctx, 5*time.Second)
	defer gateStop()
	start, e := waitGate(gateCtx, engine.Process, c.Runtime.Runner.Path)
	if e != nil {
		return result, e
	}
	recorderConfig := filepath.Join(dir, "recorder.json")
	defer os.Remove(recorderConfig)
	if e = writePrivate(recorderConfig, map[string]any{"schemaVersion": 1, "pluginPath": c.Runtime.Plugin.Path, "pluginSha256": c.Runtime.Plugin.SHA256, "landlockRunnerPath": c.Runtime.Runner.Path, "landlockRunnerSha256": c.Runtime.Runner.SHA256, "policyReadRoots": c.PolicyRoots, "temporaryDirectory": tmpDir, "socketDirectory": socketDir, "runContext": c.RunContext, "entitlementCA": c.Runtime.EntitlementCA}); e != nil {
		return result, e
	}
	journal := filepath.Join(dir, "journal")
	bc := bootstrap.Config{SocketPath: socket, EnginePID: engine.Process.Pid, EngineStartTime: start, PeerUID: uint32(os.Getuid()), ShimPath: c.Runtime.Shim.Path, ShimSHA256: c.Runtime.Shim.SHA256, RecorderPath: c.Runtime.Recorder.Path, RecorderSHA256: c.Runtime.Recorder.SHA256, RecorderConfigPath: recorderConfig, JournalPath: journal, RunNonce: result.Nonce, StartupSeconds: 5, LifetimeSeconds: c.TimeoutSeconds, MaxJournalBytes: CaptureLimit}
	configPath := filepath.Join(dir, "supervisor.json")
	if e = writePrivate(configPath, bc); e != nil {
		return result, e
	}
	supervisor := exec.Command("/proc/self/fd/3", "serve", "--config", configPath)
	supervisor.ExtraFiles = []*os.File{opened["supervisor"]}
	supervisor.Env = []string{"PATH=/usr/bin:/bin"}
	supervisor.Stderr = io.Discard
	supervisor.Stdout = io.Discard
	supervisor.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	if e = supervisor.Start(); e != nil {
		return result, e
	}
	supervisorWait := reap(supervisor)
	defer func() { retErr = errors.Join(retErr, supervisorWait.cleanup()) }()
	if e = group.attach(supervisor.Process); e != nil {
		return result, e
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if s, e := os.Lstat(socket); e == nil && s.Mode()&os.ModeSocket != 0 {
			break
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return result, errors.New("supervisor did not establish its private socket")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if identity, e := processIdentity(engine.Process.Pid); e != nil || identity != start {
		return result, errors.New("gated engine identity changed")
	}
	if _, e = gate.Write([]byte("G")); e != nil {
		return result, e
	}
	gate.Close()
	select {
	case <-engineWait.done:
	case <-ctx.Done():
		// Give Terraform a bounded opportunity to persist actual state before
		// killing the entire owned tree, including escaped process sessions.
		_ = engine.Process.Signal(os.Interrupt)
		select {
		case <-engineWait.done:
		case <-time.After(5 * time.Second):
		}
		_ = group.close()
		if e = engineWait.cleanup(); e != nil {
			return result, e
		}
	}
	e = engineWait.err
	result.ExitCode = engine.ProcessState.ExitCode()
	if e != nil && result.ExitCode == 0 {
		return result, e
	}
	select {
	case <-supervisorWait.done:
		e = supervisorWait.err
	case <-time.After(8 * time.Second):
		return result, errors.New("supervisor failed to drain after engine exit")
	}
	if e != nil {
		return result, errors.New("native policy transport failed")
	}
	select {
	case e = <-auditDone:
		if e != nil {
			return result, e
		}
	case <-time.After(time.Second):
		return result, errors.New("native audit pipe failed to close")
	}
	if planDone != nil {
		select {
		case e = <-planDone:
			if e != nil {
				return result, e
			}
		case <-time.After(time.Second):
			return result, errors.New("native saved-plan pipe failed to close")
		}
	}
	if ctx.Err() != nil {
		result.Cancelled = true
		return result, errors.New("native execution was cancelled or timed out")
	}
	if e = group.close(); e != nil {
		return result, e
	}
	result.CgroupEmpty = true
	if digest, e := snapshotDigest(c.PolicyRoots); e != nil || digest != result.PolicySnapshotSHA256 {
		return result, errors.New("immutable policy snapshot changed during execution")
	}
	if plan != "" {
		if c.Command == "plan" {
			if e = os.Chmod(plan, 0400); e != nil {
				return result, e
			}
		}
		result.PlanSHA256, e = hashFile(plan)
		if e != nil {
			return result, e
		}
		if c.SavedPlan != nil && result.PlanSHA256 != c.SavedPlan.SHA256 {
			return result, errors.New("saved plan changed during execution")
		}
	}
	// Independent show/coverage runs in a fresh bounded tree with the saved
	// plan read-only, no run credentials, and no native runtime controls.
	var planJSON, planArchive []byte
	if c.Command != "init" {
		planJSON, e = inspectPlan(ctx, c, opened, plan, dir)
		if e != nil {
			return result, e
		}
		sum := sha256.Sum256(planJSON)
		result.PlanJSONSHA256 = hex.EncodeToString(sum[:])
		planArchive, e = os.ReadFile(plan)
		if e != nil {
			return result, e
		}
		planDigest := sha256.Sum256(planArchive)
		if hex.EncodeToString(planDigest[:]) != result.PlanSHA256 {
			return result, errors.New("saved plan changed before independent inventory verification")
		}
	}
	auditBytes, e := os.ReadFile(filepath.Join(dir, "audit"))
	if e != nil {
		return result, e
	}
	journalBytes, e := os.ReadFile(journal)
	if e != nil {
		return result, e
	}
	status, e := os.ReadFile(journal + ".status.json")
	if e != nil {
		return result, e
	}
	result.Evidence, e = Verify(EvidenceInput{Command: c.Command, Nonce: result.Nonce, Roots: c.PolicyRoots, Overrides: c.Overrides, ExitCode: result.ExitCode, CgroupEmpty: result.CgroupEmpty, Audit: auditBytes, Journal: journalBytes, Transport: status, PlanJSON: planJSON, SavedPlan: planArchive})
	if e != nil {
		return result, e
	}
	for p, dest := range map[string]*string{"stdout": &result.StdoutSHA256, "audit": &result.AuditSHA256, "journal": &result.JournalSHA256} {
		*dest, e = hashFile(filepath.Join(dir, p))
		if e != nil {
			return result, e
		}
	}
	result.Verified = true
	if c.Command != "init" {
		receipt, e := sealPlan(c, result)
		if e != nil {
			return result, e
		}
		result.Receipt = &receipt
	}
	return result, nil
}

func inspectPlan(ctx context.Context, c Config, opened map[string]*os.File, plan, dir string) (data []byte, retErr error) {
	before, e := hashFile(plan)
	if e != nil {
		return nil, e
	}
	f, e := newFence(c.CgroupRoot)
	if e != nil {
		return nil, e
	}
	defer func() { retErr = errors.Join(retErr, f.close()) }()
	childCtx, stop := context.WithTimeout(ctx, 30*time.Second)
	defer stop()
	stdout, e := newCapture(filepath.Join(dir, "plan.json"), stop)
	if e != nil {
		return nil, e
	}
	defer func() { retErr = errors.Join(retErr, stdout.close()) }()
	null, e := os.Open("/dev/null")
	if e != nil {
		return nil, e
	}
	defer null.Close()
	args := append(sandboxArgs(c, plan, true), "--", "/proc/self/fd/4", "show", "-json", plan)
	cmd := exec.Command("/proc/self/fd/5", args...)
	cmd.ExtraFiles = []*os.File{null, opened["engine"], opened["runner"]}
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + c.WorkDirectory, "TMPDIR=" + c.engineTemp, "CHECKPOINT_DISABLE=1"}
	cmd.Dir = c.WorkDirectory
	cmd.Stdout = stdout
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	gate, e := cmd.StdinPipe()
	if e != nil {
		return nil, e
	}
	defer gate.Close()
	if e = cmd.Start(); e != nil {
		return nil, e
	}
	wait := reap(cmd)
	defer func() { retErr = errors.Join(retErr, wait.cleanup()) }()
	if e = f.attach(cmd.Process); e != nil {
		return nil, e
	}
	if _, e = waitGate(childCtx, cmd.Process, c.Runtime.Runner.Path); e != nil {
		return nil, e
	}
	if _, e = gate.Write([]byte("G")); e != nil {
		return nil, e
	}
	gate.Close()
	select {
	case <-wait.done:
		e = wait.err
	case <-childCtx.Done():
		f.close()
		wait.cleanup()
		return nil, errors.New("immutable saved-plan inspection timed out")
	}
	if e != nil {
		return nil, errors.New("immutable saved-plan inspection failed")
	}
	if e = f.close(); e != nil {
		return nil, e
	}
	after, e := hashFile(plan)
	if e != nil || before != after {
		return nil, errors.New("saved plan changed during independent inspection")
	}
	return os.ReadFile(filepath.Join(dir, "plan.json"))
}
