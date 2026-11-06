//go:build linux

package bootstrap

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type helperConfig struct {
	Handshake string
	Mode      string
}

func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "rpcapi" {
		if os.Getenv("TFPOLICY_JOURNAL_FD") == "3" {
			var c helperConfig
			f, e := os.Open(os.Getenv("TFPOLICY_RECORDER_CONFIG"))
			if e != nil {
				os.Exit(3)
			}
			if json.NewDecoder(f).Decode(&c) != nil {
				os.Exit(4)
			}
			j := os.NewFile(3, "journal")
			fmt.Fprintln(j, `{"event":"test-only"}`)
			fmt.Print(c.Handshake)
			if c.Mode == "extra" {
				fmt.Print("forbidden stdout")
			}
			if c.Mode == "hang" {
				time.Sleep(30 * time.Second)
			} else {
				time.Sleep(200 * time.Millisecond)
			}
			j.Close()
			os.Exit(0)
		}
		if RunShim(context.Background(), os.Getenv("TFPOLICY_SUPERVISOR_SOCKET"), os.Args[1:], os.Stdout) != nil {
			os.Exit(5)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func socketDir(t *testing.T) string {
	t.Helper()
	dir, e := os.MkdirTemp("", "tfp-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	probe, e := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(dir, "probe"), Net: "unix"})
	if e != nil {
		if errors.Is(e, syscall.EPERM) || errors.Is(e, syscall.EACCES) || errors.Is(e, syscall.EAFNOSUPPORT) {
			t.Skipf("kernel denies AF_UNIX: %v", e)
		}
		t.Fatal(e)
	}
	probe.Close()
	return dir
}
func testConfig(t *testing.T, dir string) Config {
	t.Helper()
	exe, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	exe, e = filepath.EvalSymlinks(exe)
	if e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile(exe)
	if e != nil {
		t.Fatal(e)
	}
	h := sha256.Sum256(b)
	pin := hex.EncodeToString(h[:])
	_, start, e := processStat(os.Getpid())
	if e != nil {
		t.Fatal(e)
	}
	return Config{SocketPath: filepath.Join(dir, "socket"), EnginePID: os.Getpid(), EngineStartTime: start, PeerUID: uint32(os.Getuid()), ShimPath: exe, ShimSHA256: pin, RecorderPath: exe, RecorderSHA256: pin, RecorderConfigPath: filepath.Join(dir, "recorder.json"), JournalPath: filepath.Join(dir, "journal"), RunNonce: strings.Repeat("1", 64), StartupSeconds: 2, LifetimeSeconds: 5, MaxJournalBytes: 4096}
}
func waitSocket(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, e := os.Lstat(path); e == nil {
			return
		}
		time.Sleep(time.Millisecond * 5)
	}
	t.Fatal("socket not created")
}
func TestPrivateSocketCredentialsAndNoReplacement(t *testing.T) {
	dir := socketDir(t)
	path := filepath.Join(dir, "socket")
	l, e := ListenPrivate(path)
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	st, e := os.Stat(path)
	if e != nil || st.Mode().Perm() != 0600 {
		t.Fatal("socket permissions", e)
	}
	if other, e := ListenPrivate(path); e == nil {
		other.Close()
		t.Fatal("existing socket replaced")
	}
	done := make(chan error, 1)
	go func() {
		c, e := l.AcceptUnix()
		if e != nil {
			done <- e
			return
		}
		defer c.Close()
		p, e := PeerCredentials(c)
		if e == nil && (int(p.Pid) != os.Getpid() || p.Uid != uint32(os.Getuid())) {
			e = errors.New("wrong kernel credentials")
		}
		done <- e
	}()
	c, e := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if e != nil {
		t.Fatal(e)
	}
	c.Close()
	if e = <-done; e != nil {
		t.Fatal(e)
	}
}
func TestServeLive(t *testing.T) {
	for _, mode := range []string{"ok", "extra", "hang"} {
		t.Run(mode, func(t *testing.T) {
			dir := socketDir(t)
			c := testConfig(t, dir)
			cert, serverCert := certificate(t)
			handshake := "1|1|unix|/private/test.sock|grpc|" + serverCert + "\n"
			b, _ := json.Marshal(helperConfig{handshake, mode})
			if e := os.WriteFile(c.RecorderConfigPath, b, 0600); e != nil {
				t.Fatal(e)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- Serve(ctx, c) }()
			waitSocket(t, c.SocketPath)
			shim := exec.Command(c.ShimPath, "rpcapi")
			shim.Env = []string{"TFPOLICY_SUPERVISOR_SOCKET=" + c.SocketPath, "PLUGIN_CLIENT_CERT=" + cert, "PLUGIN_PROTOCOL_VERSIONS=1", "TF_POLICY_PLUGIN=" + Cookie}
			out, e := shim.StdoutPipe()
			if e != nil {
				t.Fatal(e)
			}
			if e = shim.Start(); e != nil {
				t.Fatal(e)
			}
			defer shim.Process.Kill()
			got, e := ReadLine(bufio.NewReader(out), MaxHandshake)
			if e != nil || string(got) != handshake {
				t.Fatalf("handshake changed: %q %v", got, e)
			}
			if mode == "hang" {
				shim.Process.Kill()
			}
			select {
			case e = <-done:
				if mode != "extra" && e != nil {
					t.Fatal(e)
				}
				if mode == "extra" && e == nil {
					t.Fatal("failure accepted")
				}
			case <-time.After(6 * time.Second):
				t.Fatal("supervisor did not terminate")
			}
			shim.Wait()
			status, e := os.ReadFile(c.JournalPath + ".status.json")
			if e != nil {
				t.Fatal(e)
			}
			if !strings.Contains(string(status), `"completed":false`) {
				t.Fatal("transport falsely admitted run")
			}
			if mode == "hang" && !strings.Contains(string(status), `"transport":"engine_shutdown_observed"`) {
				t.Fatal("missing explicit shutdown disposition:", string(status))
			}
			if mode == "ok" {
				journal, e := os.ReadFile(c.JournalPath)
				if e != nil || string(journal) != "{\"event\":\"test-only\"}\n" {
					t.Fatal(string(journal), e)
				}
			}
		})
	}
}
func TestPeerRejectsImpostorAndChangedEngine(t *testing.T) {
	dir, e := os.MkdirTemp("", "tfp-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(dir)
	c := testConfig(t, dir)
	peer := &syscall.Ucred{Pid: int32(os.Getpid()), Uid: uint32(os.Getuid())}
	if _, e := ValidatePeer(c, peer); e == nil {
		t.Fatal("engine itself accepted as shim")
	}
	c.EnginePID = os.Getppid()
	_, c.EngineStartTime, _ = processStat(c.EnginePID)
	c.EngineStartTime++
	if _, e := ValidatePeer(c, peer); e == nil {
		t.Fatal("reused engine PID accepted")
	}
	peer.Uid++
	if _, e := ValidatePeer(c, peer); e == nil {
		t.Fatal("wrong uid accepted")
	}
}
func TestConfigPermissions(t *testing.T) {
	dir, e := os.MkdirTemp("", "tfp-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(dir)
	c := testConfig(t, dir)
	p := filepath.Join(dir, "run.json")
	b, _ := json.Marshal(c)
	if e := os.WriteFile(p, b, 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := LoadConfig(p); e != nil {
		t.Fatal(e)
	}
	os.Chmod(p, 0644)
	if _, e := LoadConfig(p); e == nil {
		t.Fatal("public config accepted")
	}
	os.Chmod(p, 0600)
	link := filepath.Join(dir, "link")
	os.Symlink(p, link)
	if _, e := LoadConfig(link); e == nil {
		t.Fatal("symlink config accepted")
	}
}
