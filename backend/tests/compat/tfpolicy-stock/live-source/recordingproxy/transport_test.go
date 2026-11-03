package recordingproxy

import (
	"context"
	"net"
	"testing"

	p "github.com/hashicorp/terraform/internal/policy/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

type runtimeServer struct{ p.UnimplementedPolicyServer }

func (*runtimeServer) Setup(context.Context, *p.PolicySetupRequest) (*p.PolicySetupResponse, error) {
	return &p.PolicySetupResponse{}, nil
}
func (*runtimeServer) EvaluateResource(context.Context, *p.PolicyEvaluateResourceRequest) (*p.PolicyEvaluateResourceResponse, error) {
	return &p.PolicyEvaluateResourceResponse{Result: p.EvaluateResult_DENY_EVALUATE_RESULT}, nil
}
func inMemoryClient(t *testing.T, s p.PolicyServer) p.PolicyClient {
	t.Helper()
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	p.RegisterPolicyServer(server, s)
	go server.Serve(listener)
	conn, err := grpc.NewClient("passthrough:///memory", grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(); server.Stop(); listener.Close() })
	return p.NewPolicyClient(conn)
}
func TestRealGRPCSerializationThroughRecorder(t *testing.T) {
	downstream := inMemoryClient(t, &runtimeServer{})
	journal := &Journal{}
	proxy := &Proxy{Client: downstream, Journal: journal, Bridge: func(context.Context, uint32) (uint32, error) { return 44, nil }}
	upstream := inMemoryClient(t, proxy)
	if _, err := upstream.Setup(context.Background(), &p.PolicySetupRequest{SourceLocations: []string{"snapshot"}, CallbackService: 3}); err != nil {
		t.Fatal(err)
	}
	response, err := upstream.EvaluateResource(context.Background(), request())
	if err != nil {
		t.Fatal(err)
	}
	if response.Result != p.EvaluateResult_DENY_EVALUATE_RESULT || len(response.PolicyDetails) != 0 {
		t.Fatal("response changed")
	}
	event := journal.Snapshot()[1]
	if journal.Validate(map[string]int{event.Method + ":" + event.RequestHash: 1}) == nil {
		t.Fatal("aggregate-only DENY passed")
	}
}

type nativeCallbacks struct {
	p.UnimplementedCallbackServiceServer
}

func (*nativeCallbacks) GetDataSource(ctx context.Context, r *p.GetDataSourceRequest) (*p.GetDataSourceResponse, error) {
	return &p.GetDataSourceResponse{Result: r.Config, Deferred: false}, nil
}
func callbackClient(t *testing.T, s p.CallbackServiceServer) p.CallbackServiceClient {
	t.Helper()
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	p.RegisterCallbackServiceServer(server, s)
	go server.Serve(listener)
	conn, err := grpc.NewClient("passthrough:///callback", grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(); server.Stop(); listener.Close() })
	return p.NewCallbackServiceClient(conn)
}

type callbackRuntime struct {
	p.UnimplementedPolicyServer
	callback p.CallbackServiceClient
}

func (*callbackRuntime) Setup(context.Context, *p.PolicySetupRequest) (*p.PolicySetupResponse, error) {
	return &p.PolicySetupResponse{}, nil
}
func (s *callbackRuntime) EvaluateResource(ctx context.Context, r *p.PolicyEvaluateResourceRequest) (*p.PolicyEvaluateResourceResponse, error) {
	response, err := s.callback.GetDataSource(ctx, &p.GetDataSourceRequest{EvaluationRequestId: r.EvaluationId, Type: "test_datasource", Config: r.Attrs.Raw})
	if err != nil {
		return nil, err
	}
	if string(response.Result) != string(r.Attrs.Raw) {
		return &p.PolicyEvaluateResourceResponse{Result: p.EvaluateResult_DENY_EVALUATE_RESULT}, nil
	}
	return &p.PolicyEvaluateResourceResponse{Result: p.EvaluateResult_ALLOW_EVALUATE_RESULT}, nil
}
func TestNativeCallbackRoundTripDuringEvaluation(t *testing.T) {
	journal := &Journal{}
	callback := callbackClient(t, &CallbackRelay{Client: callbackClient(t, &nativeCallbacks{}), Journal: journal})
	downstream := inMemoryClient(t, &callbackRuntime{callback: callback})
	upstream := inMemoryClient(t, &Proxy{Client: downstream, Journal: journal, Bridge: func(context.Context, uint32) (uint32, error) { return 44, nil }})
	if _, err := upstream.Setup(context.Background(), &p.PolicySetupRequest{CallbackService: 3}); err != nil {
		t.Fatal(err)
	}
	response, err := upstream.EvaluateResource(context.Background(), request())
	if err != nil || response.Result != p.EvaluateResult_ALLOW_EVALUATE_RESULT {
		t.Fatal(response, err)
	}
	events := journal.Snapshot()
	if len(events) != 3 || events[2].Method != "GetDataSource" {
		t.Fatal(events)
	}
	if err := journal.Validate(map[string]int{events[1].Method + ":" + events[1].RequestHash: 1}); err != nil {
		t.Fatal(err)
	}
}
