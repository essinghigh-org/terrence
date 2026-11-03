// Research-only mock BYOB runtime/recorder executable. No proprietary code.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"

	"github.com/hashicorp/go-plugin"
	p "github.com/hashicorp/terraform/internal/policy/proto"
	r "github.com/hashicorp/terraform/internal/policy/recordingproxy"
	"github.com/zclconf/go-cty/cty"
	"github.com/zclconf/go-cty/cty/msgpack"
	"google.golang.org/grpc"
	"google.golang.org/grpc/stats"
)

var handshake = plugin.HandshakeConfig{ProtocolVersion: 1, MagicCookieKey: "TF_POLICY_PLUGIN", MagicCookieValue: "6F11ED78A2AB"}

var cleanupMu sync.Mutex
var cleanups []func()

func cleanupAll() {
	cleanupMu.Lock()
	defer cleanupMu.Unlock()
	for _, f := range cleanups {
		f()
	}
	cleanups = nil
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
	mock bool
}

func (t *transport) GRPCClient(ctx context.Context, b *plugin.GRPCBroker, c *grpc.ClientConn) (interface{}, error) {
	return &endpoint{p.NewPolicyClient(c), b}, nil
}
func (t *transport) GRPCServer(b *plugin.GRPCBroker, s *grpc.Server) error {
	if t.mock {
		p.RegisterPolicyServer(s, &mockRuntime{broker: b})
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	client := plugin.NewClient(&plugin.ClientConfig{HandshakeConfig: handshake, Plugins: map[string]plugin.Plugin{"policy": &transport{}}, Cmd: exec.Command(executable, "mock-rpcapi"), AutoMTLS: true, AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC}, Managed: true})
	connection, err := client.Client()
	if err != nil {
		return err
	}
	raw, err := connection.Dispense("policy")
	if err != nil {
		return err
	}
	downstream := raw.(*endpoint)
	journal := &r.Journal{}
	bridge, cleanup := r.BridgeBrokers(b, downstream.broker, journal)
	cleanupMu.Lock()
	cleanups = append(cleanups, func() { cleanup(); client.Kill() })
	cleanupMu.Unlock()
	recorder := &recordingServer{inner: &r.Proxy{Client: downstream.client, Journal: journal, Bridge: bridge}, journal: journal}
	p.RegisterPolicyServer(s, recorder)
	return nil
}

type recordingServer struct {
	p.UnimplementedPolicyServer
	inner   *r.Proxy
	journal *r.Journal
	mu      sync.Mutex
}

func (s *recordingServer) flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := os.Getenv("TFPOLICY_JOURNAL")
	if path == "" {
		panic("journal path required")
	}
	data, err := json.Marshal(s.journal.Snapshot())
	if err != nil {
		panic(err)
	}
	if err = os.WriteFile(path+".tmp", data, 0600); err != nil {
		panic(err)
	}
	if err = os.Rename(path+".tmp", path); err != nil {
		panic(err)
	}
}
func (s *recordingServer) Setup(c context.Context, q *p.PolicySetupRequest) (*p.PolicySetupResponse, error) {
	v, e := s.inner.Setup(c, q)
	s.flush()
	return v, e
}
func (s *recordingServer) EvaluateResource(c context.Context, q *p.PolicyEvaluateResourceRequest) (*p.PolicyEvaluateResourceResponse, error) {
	v, e := s.inner.EvaluateResource(c, q)
	s.flush()
	return v, e
}
func (s *recordingServer) EvaluateProvider(c context.Context, q *p.PolicyEvaluateProviderRequest) (*p.PolicyEvaluateProviderResponse, error) {
	v, e := s.inner.EvaluateProvider(c, q)
	s.flush()
	return v, e
}
func (s *recordingServer) EvaluateModule(c context.Context, q *p.PolicyEvaluateModuleRequest) (*p.PolicyEvaluateModuleResponse, error) {
	v, e := s.inner.EvaluateModule(c, q)
	s.flush()
	return v, e
}

type mockRuntime struct {
	p.UnimplementedPolicyServer
	broker   *plugin.GRPCBroker
	callback p.CallbackServiceClient
}

func (s *mockRuntime) Setup(ctx context.Context, q *p.PolicySetupRequest) (*p.PolicySetupResponse, error) {
	switch os.Getenv("TFPOLICY_TEST_MODE") {
	case "incomplete":
		os.Exit(19)
	case "setup-error":
		return &p.PolicySetupResponse{Diagnostics: []*p.Diagnostic{{Severity: p.Severity_ERROR, Summary: "mock setup failure"}}}, nil
	}
	connection, err := s.broker.Dial(q.CallbackService)
	if err != nil {
		return nil, err
	}
	s.callback = p.NewCallbackServiceClient(connection)
	return &p.PolicySetupResponse{}, nil
}
func (s *mockRuntime) EvaluateResource(ctx context.Context, q *p.PolicyEvaluateResourceRequest) (*p.PolicyEvaluateResourceResponse, error) {
	if os.Getenv("TFPOLICY_TEST_MODE") == "evaluation-crash" {
		os.Exit(20)
	}
	if q.Resource != "terraform_data" || q.Metadata == nil || q.Metadata.ProviderType != "terraform" || q.Metadata.ModulePath != "" || q.Metadata.Operation != p.Operation_CREATE || q.Attrs == nil {
		return nil, fmt.Errorf("unexpected fixture resource identity")
	}
	attrs, err := msgpack.Unmarshal(q.Attrs.Raw, cty.DynamicPseudoType)
	if err != nil || !attrs.Type().IsObjectType() || !attrs.Type().HasAttribute("input") {
		return nil, fmt.Errorf("invalid fixture attributes: %v", err)
	}
	input := attrs.GetAttr("input")
	if !input.IsKnown() || input.IsNull() || input.Type() != cty.String || input.AsString() != "test-only" {
		return nil, fmt.Errorf("unexpected fixture input")
	}
	filter, err := msgpack.Marshal(cty.NullVal(cty.DynamicPseudoType), cty.DynamicPseudoType)
	if err != nil {
		return nil, err
	}
	resources, err := s.callback.GetResources(ctx, &p.GetResourcesRequest{Type: q.Resource, Attributes: filter, EvaluationRequestId: q.EvaluationId})
	if err != nil {
		return nil, err
	}
	if resources == nil || resources.Partial || len(resources.Results) != 1 {
		return nil, fmt.Errorf("native callback did not return the one fixture resource")
	}
	result := p.EvaluateResult_ALLOW_EVALUATE_RESULT
	if os.Getenv("TFPOLICY_TEST_MODE") == "deny" {
		result = p.EvaluateResult_DENY_EVALUATE_RESULT
	}
	return &p.PolicyEvaluateResourceResponse{Result: result}, nil
}
func (s *mockRuntime) EvaluateProvider(context.Context, *p.PolicyEvaluateProviderRequest) (*p.PolicyEvaluateProviderResponse, error) {
	return &p.PolicyEvaluateProviderResponse{Result: p.EvaluateResult_ALLOW_EVALUATE_RESULT}, nil
}
func (s *mockRuntime) EvaluateModule(context.Context, *p.PolicyEvaluateModuleRequest) (*p.PolicyEvaluateModuleResponse, error) {
	return &p.PolicyEvaluateModuleResponse{Result: p.EvaluateResult_ALLOW_EVALUATE_RESULT}, nil
}
func main() {
	if len(os.Args) != 2 || (os.Args[1] != "rpcapi" && os.Args[1] != "mock-rpcapi") {
		fmt.Fprintln(os.Stderr, "research harness expects rpcapi")
		os.Exit(2)
	}
	defer plugin.CleanupClients()
	plugin.Serve(&plugin.ServeConfig{HandshakeConfig: handshake, Plugins: map[string]plugin.Plugin{"policy": &transport{mock: os.Args[1] == "mock-rpcapi"}}, GRPCServer: func(options []grpc.ServerOption) *grpc.Server {
		return grpc.NewServer(append(options, grpc.StatsHandler(lifecycle{}))...)
	}})
}
