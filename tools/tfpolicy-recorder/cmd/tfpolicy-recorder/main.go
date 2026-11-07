// The production adapter is compiled against the pinned public protocol source.
// This binary does not contain or replace the Terraform command executable.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/hashicorp/go-plugin"
	p "github.com/hashicorp/terraform/internal/policy/proto"
	r "github.com/hashicorp/terraform/internal/policy/terrence-recorder"
	"google.golang.org/grpc"
	"google.golang.org/grpc/stats"
)

var handshake = plugin.HandshakeConfig{ProtocolVersion: 1, MagicCookieKey: "TF_POLICY_PLUGIN", MagicCookieValue: "6F11ED78A2AB"}
var cleanups struct {
	sync.Mutex
	items  []func()
	closed bool
}

var cleanupOnce sync.Once

func registerCleanup(f func()) {
	cleanups.Lock()
	if cleanups.closed {
		cleanups.Unlock()
		f()
		return
	}
	cleanups.items = append(cleanups.items, f)
	cleanups.Unlock()
}
func cleanupAll() {
	cleanupOnce.Do(func() {
		cleanups.Lock()
		cleanups.closed = true
		items := cleanups.items
		cleanups.items = nil
		cleanups.Unlock()
		for i := len(items) - 1; i >= 0; i-- {
			items[i]()
		}
	})
}

type lifecycle struct{}

func (lifecycle) TagRPC(c context.Context, _ *stats.RPCTagInfo) context.Context   { return c }
func (lifecycle) HandleRPC(context.Context, stats.RPCStats)                       {}
func (lifecycle) TagConn(c context.Context, _ *stats.ConnTagInfo) context.Context { return c }
func (lifecycle) HandleConn(_ context.Context, event stats.ConnStats) {
	if _, ok := event.(*stats.ConnEnd); ok {
		cleanupAll()
	}
}

type endpoint struct {
	client p.PolicyClient
	broker *plugin.GRPCBroker
}
type transport struct {
	plugin.NetRPCUnsupportedPlugin
	config  r.Config
	journal *r.Journal
}

func (t *transport) GRPCClient(_ context.Context, b *plugin.GRPCBroker, c *grpc.ClientConn) (interface{}, error) {
	return &endpoint{p.NewPolicyClient(c), b}, nil
}
func (t *transport) GRPCServer(b *plugin.GRPCBroker, s *grpc.Server) error {
	cmd, tmp, cleanup, err := r.PrepareCommand(t.config)
	if err != nil {
		return err
	}
	registerCleanup(cleanup)
	client := plugin.NewClient(&plugin.ClientConfig{HandshakeConfig: handshake, Plugins: map[string]plugin.Plugin{"policy": &transport{}}, Cmd: cmd, SkipHostEnv: true, AutoMTLS: true, AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC}, Managed: true, StartTimeout: 30 * time.Second, UnixSocketConfig: &plugin.UnixSocketConfig{TempDir: tmp}})
	registerCleanup(client.Kill)
	connection, err := client.Client()
	if err != nil {
		cleanupAll()
		return errors.New("sandboxed plugin startup failed")
	}
	raw, err := connection.Dispense("policy")
	if err != nil {
		cleanupAll()
		return errors.New("sandboxed plugin dispense failed")
	}
	downstream, ok := raw.(*endpoint)
	if !ok {
		cleanupAll()
		return errors.New("invalid sandboxed plugin endpoint")
	}
	bridge, closeBridge := r.BridgeBrokers(b, downstream.broker, t.journal)
	registerCleanup(closeBridge)
	p.RegisterPolicyServer(s, &r.Proxy{Client: downstream.client, Journal: t.journal, Bridge: bridge, PolicyRoots: t.config.PolicyReadRoots, RunContext: t.config.RunContext})
	return nil
}
func run() error {
	if len(os.Args) != 2 || os.Args[1] != "rpcapi" {
		return errors.New("recorder requires rpcapi")
	}
	if os.Getenv("TFPOLICY_JOURNAL_FD") != "3" || os.Getenv("TFPOLICY_RECORDER_CONFIG") != "/proc/self/fd/5" || os.Getenv("PLUGIN_CLIENT_CERT") == "" {
		return errors.New("trusted supervisor descriptors and client certificate required")
	}
	// Hard-coded descriptor numbers, never open a path supplied in workspace env.
	for _, fd := range []int{3, 4, 5} {
		syscall.CloseOnExec(fd)
	}
	journalFile := os.NewFile(3, "journal")
	configFile := os.NewFile(5, "config")
	if journalFile == nil || configFile == nil {
		return errors.New("missing inherited descriptor")
	}
	st, err := journalFile.Stat()
	if err != nil || st.Mode()&os.ModeNamedPipe == 0 {
		return errors.New("journal must be an inherited pipe")
	}
	configInfo, configErr := configFile.Stat()
	if configErr != nil || !configInfo.Mode().IsRegular() || configInfo.Mode().Perm()&0077 != 0 {
		return errors.New("configuration must be an inherited private regular file")
	}
	c, err := r.ReadConfig(configFile)
	_ = configFile.Close()
	if err != nil {
		return err
	}
	if err := os.Setenv("TMPDIR", c.SocketDirectory); err != nil {
		return err
	}
	registerCleanup(func() { _ = journalFile.Close() })
	journal := r.NewJournal(journalFile, func() { cleanupAll(); os.Exit(1) })
	plugin.Serve(&plugin.ServeConfig{HandshakeConfig: handshake, Plugins: map[string]plugin.Plugin{"policy": &transport{config: c, journal: journal}}, GRPCServer: func(options []grpc.ServerOption) *grpc.Server {
		return grpc.NewServer(append(options, grpc.StatsHandler(lifecycle{}))...)
	}})
	cleanupAll()
	return nil
}
func main() {
	if err := run(); err != nil {
		cleanupAll()
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
