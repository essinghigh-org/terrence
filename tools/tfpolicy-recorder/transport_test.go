package recorder

import (
	"bytes"
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
	buffer := new(bytes.Buffer)
	journal := NewJournal(buffer, nil)
	proxy := &Proxy{Client: downstream, Journal: journal, PolicyRoots: []string{"snapshot"}, Bridge: func(context.Context, uint32) (uint32, error) { return 44, nil }}
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
	event := records(t, buffer)[3]
	if event.Error == nil || event.Result != nil {
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
	buffer := new(bytes.Buffer)
	journal := NewJournal(buffer, nil)
	callback := callbackClient(t, &CallbackRelay{Client: callbackClient(t, &nativeCallbacks{}), Journal: journal})
	downstream := inMemoryClient(t, &callbackRuntime{callback: callback})
	upstream := inMemoryClient(t, &Proxy{Client: downstream, Journal: journal, PolicyRoots: []string{"snapshot"}, Bridge: func(context.Context, uint32) (uint32, error) { return 44, nil }})
	if _, err := upstream.Setup(context.Background(), &p.PolicySetupRequest{SourceLocations: []string{"snapshot"}, CallbackService: 3}); err != nil {
		t.Fatal(err)
	}
	response, err := upstream.EvaluateResource(context.Background(), request())
	if err != nil || response.Result != p.EvaluateResult_ALLOW_EVALUATE_RESULT {
		t.Fatal(response, err)
	}
	events := records(t, buffer)
	if len(events) != 6 || events[3].Method != "GetDataSource" || events[3].Phase != "begin" || events[4].Error != nil || events[5].Result == nil {
		t.Fatal(events)
	}
}
