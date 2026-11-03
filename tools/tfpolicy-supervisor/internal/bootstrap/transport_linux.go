//go:build linux

package bootstrap

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func PeerCredentials(c *net.UnixConn) (*syscall.Ucred, error) {
	raw, e := c.SyscallConn()
	if e != nil {
		return nil, e
	}
	var cred *syscall.Ucred
	var inner error
	e = raw.Control(func(fd uintptr) {
		cred, inner = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if e != nil {
		return nil, e
	}
	return cred, inner
}

func processStat(pid int) (int, uint64, error) {
	b, e := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if e != nil {
		return 0, 0, e
	}
	return ParseStat(string(b))
}

// ValidatePeer reads kernel identity, not claimed request fields. /proc must be
// a trusted procfs in the supervisor PID namespace, never a sandbox-provided mount.
func ValidatePeer(c Config, peer *syscall.Ucred) (uint64, error) {
	if peer == nil || peer.Uid != c.PeerUID || peer.Pid <= 1 {
		return 0, errors.New("unauthorized peer credentials")
	}
	pid := int(peer.Pid)
	parent, start, e := processStat(pid)
	if e != nil {
		return 0, e
	}
	if parent != c.EnginePID {
		return 0, errors.New("peer is not direct engine child")
	}
	_, engineStart, e := processStat(c.EnginePID)
	if e != nil || engineStart != c.EngineStartTime {
		return 0, errors.New("engine PID identity mismatch")
	}
	path := fmt.Sprintf("/proc/%d/exe", pid)
	actual, e := os.Readlink(path)
	if e != nil || actual != c.ShimPath {
		return 0, errors.New("peer executable path mismatch")
	}
	f, e := os.Open(path)
	if e != nil {
		return 0, e
	}
	defer f.Close()
	if e = CheckPinned(f, c.ShimSHA256); e != nil {
		return 0, e
	}
	args, e := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if e != nil {
		return 0, e
	}
	argv := strings.Split(string(args), "\x00")
	if len(argv) != 3 || argv[1] != "rpcapi" || argv[2] != "" {
		return 0, errors.New("peer must be invoked with exactly rpcapi")
	}
	parent2, start2, e := processStat(pid)
	if e != nil || parent2 != parent || start2 != start {
		return 0, errors.New("peer identity changed")
	}
	return start, nil
}

func privateFile(path string) (*os.File, error) {
	fd, e := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), path)
	info, e := f.Stat()
	if e != nil {
		f.Close()
		return nil, e
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || st.Uid != uint32(os.Geteuid()) {
		f.Close()
		return nil, errors.New("trusted config must be private, regular, and supervisor-owned")
	}
	return f, nil
}

func LoadConfig(path string) (Config, error) {
	var c Config
	f, e := privateFile(path)
	if e != nil {
		return c, e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return c, e
	}
	if info.Size() > 65536 {
		return c, errors.New("config too large")
	}
	d := json.NewDecoder(io.LimitReader(f, 65537))
	d.DisallowUnknownFields()
	if e = d.Decode(&c); e != nil {
		return c, e
	}
	if d.Decode(new(any)) != io.EOF {
		return c, errors.New("trailing config data")
	}
	return c, c.Validate()
}

func privateDirectory(path string) error {
	info, e := os.Lstat(path)
	if e != nil {
		return e
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode().Perm() != 0700 || st.Uid != uint32(os.Geteuid()) {
		return errors.New("socket/journal parent must be private supervisor-owned directory (0700)")
	}
	return nil
}

// ListenPrivate never unlinks an existing pathname: a stale socket is a failed
// run requiring trusted launcher cleanup, not permission to replace a file.
func ListenPrivate(path string) (*net.UnixListener, error) {
	if e := privateDirectory(filepath.Dir(path)); e != nil {
		return nil, e
	}
	if _, e := os.Lstat(path); !errors.Is(e, os.ErrNotExist) {
		return nil, errors.New("socket path already exists or cannot be checked")
	}
	l, e := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if e != nil {
		return nil, e
	}
	if e = os.Chmod(path, 0600); e != nil {
		l.Close()
		return nil, e
	}
	return l, nil
}

// Serve admits one authenticated connection. Unauthenticated attempts fail the
// run closed rather than allowing an attacker to consume unbounded resources.
func Serve(parent context.Context, c Config) (retErr error) {
	transportStatus := "failed"
	if e := c.Validate(); e != nil {
		return e
	}
	if e := privateDirectory(filepath.Dir(c.JournalPath)); e != nil {
		return e
	}
	// This status is deliberately NOT an admission receipt. Missing status, any
	// error, and recorder success without parent engine correlation all fail closed.
	defer func() {
		status := struct {
			Nonce     string `json:"run_nonce"`
			Completed bool   `json:"completed"`
			Transport string `json:"transport"`
		}{c.RunNonce, false, "failed"}
		if retErr == nil {
			status.Transport = transportStatus
		}
		f, e := os.OpenFile(c.JournalPath+".status.json", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e == nil {
			e = json.NewEncoder(f).Encode(status)
			if se := f.Sync(); e == nil {
				e = se
			}
			f.Close()
		}
		if retErr == nil && e != nil {
			retErr = e
		}
	}()
	recorderConfig, e := privateFile(c.RecorderConfigPath)
	if e != nil {
		return e
	}
	defer recorderConfig.Close()
	recorder, e := os.Open(c.RecorderPath)
	if e != nil {
		return e
	}
	defer recorder.Close()
	if e = CheckPinned(recorder, c.RecorderSHA256); e != nil {
		return e
	}
	journal, e := os.OpenFile(c.JournalPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	defer journal.Close()
	listener, e := ListenPrivate(c.SocketPath)
	if e != nil {
		return e
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(parent, time.Duration(c.LifetimeSeconds)*time.Second)
	defer cancel()
	go func() { <-ctx.Done(); listener.Close() }()
	listener.SetDeadline(time.Now().Add(c.StartupTimeout()))
	conn, e := listener.AcceptUnix()
	if e != nil {
		return e
	}
	defer conn.Close()
	go func() { <-ctx.Done(); conn.Close() }()
	listener.Close() // single-use, regardless of validation outcome
	peer, e := PeerCredentials(conn)
	if e != nil {
		return e
	}
	peerStart, e := ValidatePeer(c, peer)
	if e != nil {
		return e
	}
	conn.SetDeadline(time.Now().Add(c.StartupTimeout()))
	reader := bufio.NewReaderSize(conn, 4096)
	line, e := ReadLine(reader, MaxRequest)
	if e != nil {
		return e
	}
	req, e := DecodeRequest(line)
	if e != nil {
		return e
	}
	if reader.Buffered() != 0 {
		return errors.New("unexpected bootstrap payload")
	}
	checkStart, e := ValidatePeer(c, peer)
	if e != nil || checkStart != peerStart {
		return errors.New("peer identity changed before launch")
	}
	jr, jw, e := os.Pipe()
	if e != nil {
		return e
	}
	defer jr.Close()
	defer jw.Close()
	// Execute the verified open inode, not a pathname that can be replaced between
	// hash validation and exec. FD3 is journal; FD4 executable; FD5 fixed config.
	cmd := exec.CommandContext(ctx, "/proc/self/fd/4", "rpcapi")
	cmd.Args[0] = c.RecorderPath
	cmd.ExtraFiles = []*os.File{jw, recorder, recorderConfig}
	cmd.Env = []string{"PLUGIN_CLIENT_CERT=" + req.ClientCertificate, "PLUGIN_PROTOCOL_VERSIONS=" + req.ProtocolVersions, "TF_POLICY_PLUGIN=" + Cookie, "TFPOLICY_RUN_NONCE=" + c.RunNonce, "TFPOLICY_JOURNAL_FD=3", "TFPOLICY_RECORDER_CONFIG=/proc/self/fd/5"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	cmd.Stderr = io.Discard // never copy untrusted diagnostic bytes into evidence
	stdout, stdoutWriter, e := os.Pipe()
	if e != nil {
		return e
	}
	defer stdout.Close()
	defer stdoutWriter.Close()
	cmd.Stdout = stdoutWriter
	if e = cmd.Start(); e != nil {
		return e
	}
	jw.Close()
	stdoutWriter.Close()
	kill := func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	defer kill()
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	journalDone := make(chan error, 1)
	go func() {
		n, e := io.Copy(journal, io.LimitReader(jr, c.MaxJournalBytes+1))
		if n > c.MaxJournalBytes {
			e = errors.New("journal size limit exceeded")
		}
		if e == nil {
			e = journal.Sync()
		}
		journalDone <- e
	}()
	disconnected := make(chan error, 1)
	go func() {
		var b [1]byte
		_, e := reader.Read(b[:])
		if e == nil {
			e = errors.New("unexpected shim data")
		}
		disconnected <- e
	}()
	// Engine/peer death or reparenting revokes the process authorization, even if
	// another process inherited the socket descriptor and keeps it open.
	identityGone := errors.New("engine or shim process disappeared")
	lostIdentity := make(chan error, 1)
	go func() {
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				p, s, e := processStat(int(peer.Pid))
				_, es, ee := processStat(c.EnginePID)
				if os.IsNotExist(e) || os.IsNotExist(ee) || (e == nil && p != c.EnginePID) {
					lostIdentity <- identityGone
					return
				}
				if e != nil || ee != nil || s != peerStart || es != c.EngineStartTime {
					lostIdentity <- errors.New("engine or shim identity changed")
					return
				}
			}
		}
	}()
	handshake := make(chan struct {
		line []byte
		err  error
	}, 1)
	stdoutReader := bufio.NewReaderSize(stdout, 4096)
	go func() {
		b, e := ReadLine(stdoutReader, MaxHandshake)
		if e == nil {
			e = ValidateHandshake(b)
		}
		handshake <- struct {
			line []byte
			err  error
		}{b, e}
	}()
	timer := time.NewTimer(c.StartupTimeout())
	defer timer.Stop()
	select {
	case h := <-handshake:
		if h.err != nil {
			kill()
			<-exited
			return h.err
		}
		if _, e = conn.Write(h.line); e != nil {
			kill()
			<-exited
			return e
		}
	case <-timer.C:
		kill()
		<-exited
		return errors.New("recorder handshake timeout")
	case <-disconnected:
		kill()
		<-exited
		return errors.New("shim disconnected before handshake")
	case e := <-lostIdentity:
		kill()
		<-exited
		return e
	case <-ctx.Done():
		kill()
		<-exited
		return ctx.Err()
	}
	conn.SetDeadline(time.Time{})
	// Anything after the handshake is forbidden, not an evidence channel.
	stdoutDone := make(chan error, 1)
	go func() {
		var b [1]byte
		n, e := stdoutReader.Read(b[:])
		if n > 0 {
			stdoutDone <- errors.New("unexpected recorder stdout")
		} else if e != io.EOF {
			stdoutDone <- e
		} else {
			stdoutDone <- nil
		}
	}()
	journalClosed := false
	stdoutClosed := false
	stdoutResult := stdoutDone
	journalResult := journalDone
	drain := func() error {
		timer := time.NewTimer(time.Second)
		defer timer.Stop()
		for !journalClosed || !stdoutClosed {
			select {
			case e := <-journalResult:
				if e != nil {
					return e
				}
				journalClosed = true
				journalResult = nil
			case e := <-stdoutResult:
				if e != nil {
					return e
				}
				stdoutClosed = true
				stdoutResult = nil
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return errors.New("recorder pipes failed to close")
			}
		}
		return ctx.Err()
	}
	observeShutdown := func() error {
		// Do not relabel a recorder failure that raced with normal teardown.
		var stopErr error
		select {
		case stopErr = <-exited:
			if stopErr != nil {
				return stopErr
			}
		default:
			kill()
			stopErr = <-exited
			if stopErr != nil {
				var exitErr *exec.ExitError
				if !errors.As(stopErr, &exitErr) {
					return stopErr
				}
				status, ok := exitErr.Sys().(syscall.WaitStatus)
				if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
					return stopErr
				}
			}
		}
		if e := drain(); e != nil {
			return e
		}
		transportStatus = "engine_shutdown_observed"
		return nil
	}
	for {
		select {
		case e := <-exited:
			if e != nil {
				return e
			}
			if e = drain(); e != nil {
				return e
			}
			transportStatus = "recorder_exited_cleanly"
			return nil
		case e := <-journalResult:
			if e != nil {
				kill()
				<-exited
				return e
			}
			journalClosed = true
			journalResult = nil
		case e := <-stdoutResult:
			if e != nil {
				kill()
				<-exited
				return e
			}
			stdoutClosed = true
			stdoutResult = nil
		case e := <-disconnected:
			if e != io.EOF {
				kill()
				<-exited
				return errors.New("invalid shim teardown")
			}
			return observeShutdown()
		case e := <-lostIdentity:
			if e == identityGone {
				return observeShutdown()
			}
			kill()
			<-exited
			return e
		case <-ctx.Done():
			kill()
			<-exited
			return ctx.Err()
		}
	}
}

func RunShim(ctx context.Context, socket string, args []string, out io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if len(args) != 1 || args[0] != "rpcapi" {
		return errors.New("shim requires exactly rpcapi")
	}
	if !filepath.IsAbs(socket) || filepath.Clean(socket) != socket || len(socket) > 100 {
		return errors.New("invalid supervisor socket path")
	}
	req := Request{os.Getenv("PLUGIN_CLIENT_CERT"), os.Getenv("PLUGIN_PROTOCOL_VERSIONS"), os.Getenv("TF_POLICY_PLUGIN")}
	if e := req.Validate(); e != nil {
		return e
	}
	d := net.Dialer{Timeout: 10 * time.Second}
	raw, e := d.DialContext(ctx, "unix", socket)
	if e != nil {
		return e
	}
	defer raw.Close()
	conn := raw.(*net.UnixConn)
	go func() { <-ctx.Done(); conn.Close() }()
	conn.SetDeadline(time.Now().Add(60 * time.Second))
	b, e := json.Marshal(req)
	if e != nil {
		return e
	}
	if len(b)+1 > MaxRequest {
		return errors.New("request too large")
	}
	if _, e = conn.Write(append(b, '\n')); e != nil {
		return e
	}
	r := bufio.NewReaderSize(conn, 4096)
	line, e := ReadLine(r, MaxHandshake)
	if e != nil {
		return e
	}
	if e = ValidateHandshake(line); e != nil {
		return e
	}
	if _, e = out.Write(line); e != nil {
		return e
	}
	conn.SetDeadline(time.Time{})
	var extra [1]byte
	_, e = r.Read(extra[:])
	if e == io.EOF {
		return nil
	}
	if e == nil {
		return errors.New("unexpected supervisor payload")
	}
	return e
}
