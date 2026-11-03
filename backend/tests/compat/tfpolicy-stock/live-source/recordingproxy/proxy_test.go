package recordingproxy

import (
	"context"
	"errors"
	p "github.com/hashicorp/terraform/internal/policy/proto"
	"google.golang.org/grpc"
	pb "google.golang.org/protobuf/proto"
	"testing"
)

type fake struct {
	p.PolicyClient
	setup    *p.PolicySetupRequest
	resource *p.PolicyEvaluateResourceRequest
	result   p.EvaluateResult
	err      error
}

func (f *fake) Setup(c context.Context, r *p.PolicySetupRequest, o ...grpc.CallOption) (*p.PolicySetupResponse, error) {
	f.setup = r
	return &p.PolicySetupResponse{}, nil
}
func (f *fake) EvaluateResource(c context.Context, r *p.PolicyEvaluateResourceRequest, o ...grpc.CallOption) (*p.PolicyEvaluateResourceResponse, error) {
	f.resource = r
	if f.err != nil {
		return nil, f.err
	}
	return &p.PolicyEvaluateResourceResponse{Result: f.result}, nil
}
func fixture(t *testing.T) (*Proxy, *fake) {
	t.Helper()
	f := &fake{result: p.EvaluateResult_ALLOW_EVALUATE_RESULT}
	s := &Proxy{Client: f, Journal: &Journal{}, Bridge: func(c context.Context, id uint32) (uint32, error) {
		if id != 7 {
			t.Fatal(id)
		}
		return 22, nil
	}}
	_, e := s.Setup(context.Background(), &p.PolicySetupRequest{CallbackService: 7, SourceLocations: []string{"immutable/policies"}, Entitlement: &p.PolicySetupRequest_Entitlement{Token: "not-recorded"}})
	if e != nil {
		t.Fatal(e)
	}
	return s, f
}
func request() *p.PolicyEvaluateResourceRequest {
	return &p.PolicyEvaluateResourceRequest{EvaluationId: 123, Resource: "test_resource", Attrs: &p.ResourceAttributes{Raw: []byte("typed attributes")}, Metadata: &p.PolicyEvaluateResourceRequest_ResourceMetadata{Operation: p.Operation_CREATE}}
}
func TestSetupAndResourcePreserved(t *testing.T) {
	s, f := fixture(t)
	if f.setup.CallbackService != 22 || f.setup.Entitlement.Token != "not-recorded" {
		t.Fatal("bad setup relay")
	}
	r := request()
	s.EvaluateResource(context.Background(), r)
	if !pb.Equal(f.resource, r) {
		t.Fatal("request changed")
	}
	e := s.Journal.Snapshot()[1]
	if err := s.Journal.Validate(map[string]int{e.Method + ":" + e.RequestHash: 1}); err != nil {
		t.Fatal(err)
	}
}
func TestAggregateOnlyDenyCannotDisappear(t *testing.T) {
	s, f := fixture(t)
	f.result = p.EvaluateResult_DENY_EVALUATE_RESULT
	s.EvaluateResource(context.Background(), request())
	e := s.Journal.Snapshot()[1]
	if s.Journal.Validate(map[string]int{e.Method + ":" + e.RequestHash: 1}) == nil {
		t.Fatal("aggregate DENY admitted")
	}
}
func TestErrorAndMissingInventory(t *testing.T) {
	s, f := fixture(t)
	if s.Journal.Validate(nil) == nil {
		t.Fatal("missing inventory admitted")
	}
	f.err = errors.New("plugin died")
	s.EvaluateResource(context.Background(), request())
	if s.Journal.Validate(map[string]int{}) == nil {
		t.Fatal("RPC error admitted")
	}
}
func TestMissingOrDuplicateCalls(t *testing.T) {
	s, _ := fixture(t)
	s.EvaluateResource(context.Background(), request())
	e := s.Journal.Snapshot()[1]
	k := e.Method + ":" + e.RequestHash
	if s.Journal.Validate(map[string]int{k: 2}) == nil {
		t.Fatal("missing admitted")
	}
	s.EvaluateResource(context.Background(), request())
	if s.Journal.Validate(map[string]int{k: 1}) == nil {
		t.Fatal("duplicate admitted")
	}
}
func TestUnknownInvalidAndSetupError(t *testing.T) {
	for _, v := range []p.EvaluateResult{p.EvaluateResult_UNKNOWN_EVALUATE_RESULT, p.EvaluateResult_INVALID_EVALUATE_RESULT, p.EvaluateResult_SETUP_ERROR_EVALUATE_RESULT} {
		s, f := fixture(t)
		f.result = v
		s.EvaluateResource(context.Background(), request())
		e := s.Journal.Snapshot()[1]
		if s.Journal.Validate(map[string]int{e.Method + ":" + e.RequestHash: 1}) == nil {
			t.Fatal(v)
		}
	}
}
func TestDuplicateSetupAndBeforeSetup(t *testing.T) {
	s, _ := fixture(t)
	if _, e := s.Setup(context.Background(), &p.PolicySetupRequest{}); e == nil {
		t.Fatal("duplicate accepted")
	}
	s = &Proxy{Journal: &Journal{}}
	if _, e := s.EvaluateResource(context.Background(), request()); e == nil {
		t.Fatal("uninitialized accepted")
	}
}

type callbacks struct {
	p.CallbackServiceClient
	request  *p.GetResourcesRequest
	response *p.GetResourcesResponse
}

func (f *callbacks) GetResources(c context.Context, r *p.GetResourcesRequest, o ...grpc.CallOption) (*p.GetResourcesResponse, error) {
	f.request = r
	return f.response, nil
}
func TestCallbackPayloadPreservedAndPartialRejected(t *testing.T) {
	s, _ := fixture(t)
	f := &callbacks{response: &p.GetResourcesResponse{Results: [][]byte{[]byte("typed raw response")}}}
	relay := &CallbackRelay{Client: f, Journal: s.Journal}
	request := &p.GetResourcesRequest{EvaluationRequestId: 123, Attributes: []byte("typed raw request")}
	r, e := relay.GetResources(context.Background(), request)
	if e != nil || !pb.Equal(f.request, request) || !pb.Equal(r, f.response) {
		t.Fatal("callback changed")
	}
	if e := s.Journal.Validate(map[string]int{}); e != nil {
		t.Fatal(e)
	}
	f.response.Partial = true
	relay.GetResources(context.Background(), request)
	if s.Journal.Validate(map[string]int{}) == nil {
		t.Fatal("partial callback admitted")
	}
}
func TestContradictoryAllowAndErrorRejected(t *testing.T) {
	d := []*p.PolicyEvaluationDetail{{Result: p.EvaluateResult_ALLOW_EVALUATE_RESULT, Diagnostics: []*p.Diagnostic{{Severity: p.Severity_ERROR}}}}
	if !badDetails(d) {
		t.Fatal("error hidden by ALLOW")
	}
}
