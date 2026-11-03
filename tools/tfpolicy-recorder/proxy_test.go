package recorder

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"

	p "github.com/hashicorp/terraform/internal/policy/proto"
	"google.golang.org/grpc"
	pb "google.golang.org/protobuf/proto"
)

type fake struct {
	p.PolicyClient
	setup            *p.PolicySetupRequest
	setupDiagnostics []*p.Diagnostic
	resource         *p.PolicyEvaluateResourceRequest
	result           p.EvaluateResult
	details          []*p.PolicyEvaluationDetail
	err              error
	during           func()
}

func (f *fake) Setup(_ context.Context, r *p.PolicySetupRequest, _ ...grpc.CallOption) (*p.PolicySetupResponse, error) {
	f.setup = r
	return &p.PolicySetupResponse{Diagnostics: f.setupDiagnostics}, nil
}
func (f *fake) EvaluateResource(_ context.Context, r *p.PolicyEvaluateResourceRequest, _ ...grpc.CallOption) (*p.PolicyEvaluateResourceResponse, error) {
	f.resource = r
	if f.during != nil {
		f.during()
	}
	if f.err != nil {
		return nil, f.err
	}
	return &p.PolicyEvaluateResourceResponse{Result: f.result, PolicyDetails: f.details}, nil
}
func (f *fake) EvaluateProvider(context.Context, *p.PolicyEvaluateProviderRequest, ...grpc.CallOption) (*p.PolicyEvaluateProviderResponse, error) {
	return &p.PolicyEvaluateProviderResponse{Result: f.result, PolicyDetails: f.details}, f.err
}
func (f *fake) EvaluateModule(context.Context, *p.PolicyEvaluateModuleRequest, ...grpc.CallOption) (*p.PolicyEvaluateModuleResponse, error) {
	return &p.PolicyEvaluateModuleResponse{Result: f.result, PolicyDetails: f.details}, f.err
}
func records(t *testing.T, b *bytes.Buffer) []Record {
	t.Helper()
	d := json.NewDecoder(bytes.NewReader(b.Bytes()))
	var out []Record
	for {
		var r Record
		err := d.Decode(&r)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if r.Sequence != len(out) {
			t.Fatal("bad sequence")
		}
		out = append(out, r)
	}
	return out
}
func fixture(t *testing.T) (*Proxy, *fake, *bytes.Buffer) {
	t.Helper()
	b := new(bytes.Buffer)
	f := &fake{result: p.EvaluateResult_ALLOW_EVALUATE_RESULT}
	s := &Proxy{Client: f, Journal: NewJournal(b, nil), PolicyRoots: []string{"/snapshot/policies"}, Bridge: func(_ context.Context, id uint32) (uint32, error) {
		if id != 7 {
			t.Fatal(id)
		}
		return 22, nil
	}}
	_, err := s.Setup(context.Background(), &p.PolicySetupRequest{SourceLocations: s.PolicyRoots, CallbackService: 7, Entitlement: &p.PolicySetupRequest_Entitlement{Token: "secret-never-recorded"}})
	if err != nil {
		t.Fatal(err)
	}
	return s, f, b
}
func request() *p.PolicyEvaluateResourceRequest {
	return &p.PolicyEvaluateResourceRequest{EvaluationId: 123, Resource: "test_resource", Attrs: &p.ResourceAttributes{Raw: []byte("typed attributes")}, Metadata: &p.PolicyEvaluateResourceRequest_ResourceMetadata{Operation: p.Operation_CREATE}}
}
func TestBeginWrittenBeforeRPCAndExactForwarding(t *testing.T) {
	s, f, b := fixture(t)
	f.during = func() {
		rs := records(t, b)
		if len(rs) != 3 || rs[2].Phase != "begin" {
			t.Fatal("missing pre-RPC begin")
		}
	}
	req := request()
	resp, err := s.EvaluateResource(context.Background(), req)
	if err != nil || resp.Result != p.EvaluateResult_ALLOW_EVALUATE_RESULT {
		t.Fatal(resp, err)
	}
	if !pb.Equal(req, f.resource) || f.setup.CallbackService != 22 || f.setup.Entitlement.Token != "secret-never-recorded" {
		t.Fatal("request changed")
	}
	rs := records(t, b)
	if len(rs) != 4 || rs[2].ID != rs[3].ID || rs[2].RequestSHA256 != rs[3].RequestSHA256 || rs[3].Result == nil || *rs[3].Result != "ALLOW" || rs[3].Error != nil {
		t.Fatal(rs)
	}
	if strings.Contains(b.String(), "typed attributes") || strings.Contains(b.String(), "secret-never-recorded") {
		t.Fatal("raw sensitive payload persisted")
	}
}
func TestDenialUnknownAndContradictoryDiagnostics(t *testing.T) {
	for _, value := range []p.EvaluateResult{p.EvaluateResult_DENY_EVALUATE_RESULT, p.EvaluateResult_UNKNOWN_EVALUATE_RESULT, p.EvaluateResult_INVALID_EVALUATE_RESULT, p.EvaluateResult_SETUP_ERROR_EVALUATE_RESULT, p.EvaluateResult(99)} {
		s, f, b := fixture(t)
		f.result = value
		_, _ = s.EvaluateResource(context.Background(), request())
		rs := records(t, b)
		if rs[3].Error == nil || rs[3].Result != nil {
			t.Fatal(value, rs)
		}
	}
	s, f, b := fixture(t)
	f.details = []*p.PolicyEvaluationDetail{{Result: p.EvaluateResult_ALLOW_EVALUATE_RESULT, Diagnostics: []*p.Diagnostic{{Severity: p.Severity_ERROR}}}}
	_, _ = s.EvaluateResource(context.Background(), request())
	if records(t, b)[3].Error == nil {
		t.Fatal("ALLOW hid diagnostic error")
	}
}
func TestAllEvaluationMethodsRecordAndErrorsAreRedacted(t *testing.T) {
	s, f, b := fixture(t)
	f.err = errors.New("secret error text")
	_, _ = s.EvaluateProvider(context.Background(), &p.PolicyEvaluateProviderRequest{})
	_, _ = s.EvaluateModule(context.Background(), &p.PolicyEvaluateModuleRequest{})
	_, _ = s.EvaluateResource(context.Background(), request())
	rs := records(t, b)
	if len(rs) != 8 {
		t.Fatal(rs)
	}
	for _, i := range []int{3, 5, 7} {
		if rs[i].Error == nil {
			t.Fatal("missing error")
		}
	}
	if strings.Contains(b.String(), "secret error text") {
		t.Fatal("raw plugin error persisted")
	}
}
func TestSourceMismatchAndSetupOrdering(t *testing.T) {
	s, _, b := fixture(t)
	if _, err := s.Setup(context.Background(), &p.PolicySetupRequest{}); err == nil {
		t.Fatal("duplicate Setup")
	}
	if records(t, b)[3].Error == nil {
		t.Fatal("missing duplicate evidence")
	}
	b = new(bytes.Buffer)
	s = &Proxy{Journal: NewJournal(b, nil)}
	if _, err := s.EvaluateResource(context.Background(), request()); err == nil {
		t.Fatal("before setup")
	}
	s = &Proxy{Journal: NewJournal(new(bytes.Buffer), nil), PolicyRoots: []string{"/approved"}}
	if _, err := s.Setup(context.Background(), &p.PolicySetupRequest{SourceLocations: []string{"/workspace"}}); err == nil {
		t.Fatal("wrong source accepted")
	}
}

type callbacks struct {
	p.CallbackServiceClient
	request  *p.GetResourcesRequest
	response *p.GetResourcesResponse
}

func (f *callbacks) GetResources(_ context.Context, r *p.GetResourcesRequest, _ ...grpc.CallOption) (*p.GetResourcesResponse, error) {
	f.request = r
	return f.response, nil
}
func TestCallbackCorrelationAndPayload(t *testing.T) {
	s, f, b := fixture(t)
	native := &callbacks{response: &p.GetResourcesResponse{Results: [][]byte{[]byte("native bytes")}}}
	relay := &CallbackRelay{Client: native, Journal: s.Journal}
	req := &p.GetResourcesRequest{EvaluationRequestId: 123, Attributes: []byte("native filter")}
	f.during = func() {
		resp, err := relay.GetResources(context.Background(), req)
		if err != nil || !pb.Equal(native.request, req) || !pb.Equal(resp, native.response) {
			t.Fatal("callback changed")
		}
	}
	_, _ = s.EvaluateResource(context.Background(), request())
	rs := records(t, b)
	if len(rs) != 6 || rs[3].Method != "GetResources" || rs[4].Error != nil {
		t.Fatal(rs)
	}
	if _, err := relay.GetResources(context.Background(), req); err == nil {
		t.Fatal("out-of-evaluation callback accepted")
	}
	native.response.Partial = true
	_, _ = s.EvaluateResource(context.Background(), request())
	rs = records(t, b)
	if rs[len(rs)-2].Error == nil {
		t.Fatal("partial response not marked")
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("closed") }
func TestJournalFailureStopsRPCAndBounds(t *testing.T) {
	aborted := make(chan struct{}, 1)
	j := NewJournal(failingWriter{}, func() { aborted <- struct{}{} })
	s := &Proxy{Journal: j}
	if _, err := s.EvaluateResource(context.Background(), request()); err == nil {
		t.Fatal("journal failure ignored")
	}
	<-aborted
	b := new(bytes.Buffer)
	j = NewJournal(b, nil)
	j.sequence = MaxJournalRecords
	if _, err := j.begin("Setup", &p.PolicySetupRequest{}); err == nil || b.Len() != 0 {
		t.Fatal("record limit ignored")
	}
	j = NewJournal(b, nil)
	j.bytes = MaxJournalBytes
	if _, err := j.begin("Setup", &p.PolicySetupRequest{}); err == nil || b.Len() != 0 {
		t.Fatal("byte limit ignored")
	}
}

func TestSetupCredentialsExcludedFromHash(t *testing.T) {
	_, _, b := fixture(t)
	sanitized := &p.PolicySetupRequest{SourceLocations: []string{"/snapshot/policies"}, CallbackService: 7}
	encoded, err := (pb.MarshalOptions{Deterministic: true}).Marshal(sanitized)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(encoded)
	if records(t, b)[0].RequestSHA256 != hex.EncodeToString(sum[:]) {
		t.Fatal("Setup hash included entitlement")
	}
}
func TestSetupAndEnforcementDiagnosticsFailClosed(t *testing.T) {
	for _, diag := range []*p.Diagnostic{nil, {Severity: p.Severity_ERROR}, {Severity: p.Severity(99)}} {
		b := new(bytes.Buffer)
		f := &fake{setupDiagnostics: []*p.Diagnostic{diag}}
		s := &Proxy{Client: f, Journal: NewJournal(b, nil), PolicyRoots: []string{"/snapshot"}, Bridge: func(context.Context, uint32) (uint32, error) { return 1, nil }}
		_, _ = s.Setup(context.Background(), &p.PolicySetupRequest{SourceLocations: s.PolicyRoots, CallbackService: 1})
		if records(t, b)[1].Error == nil || s.Journal.admitted() {
			t.Fatal("Setup diagnostic accepted")
		}
	}
	for _, enforce := range []*p.EnforceBlockResult{nil, {Result: p.EvaluateResult_DENY_EVALUATE_RESULT}, {Result: p.EvaluateResult_ALLOW_EVALUATE_RESULT, Diagnostics: []*p.Diagnostic{{Severity: p.Severity_ERROR}}}} {
		s, f, b := fixture(t)
		f.details = []*p.PolicyEvaluationDetail{{Result: p.EvaluateResult_ALLOW_EVALUATE_RESULT, EnforceResults: []*p.EnforceBlockResult{enforce}}}
		_, _ = s.EvaluateResource(context.Background(), request())
		if records(t, b)[3].Error == nil {
			t.Fatal("enforcement error accepted")
		}
	}
}
func TestJournalConcurrentRecordsRemainPairedAndOrdered(t *testing.T) {
	b := new(bytes.Buffer)
	j := NewJournal(b, nil)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			c, err := j.begin("EvaluateResource", &p.PolicyEvaluateResourceRequest{EvaluationId: uint32(n)})
			if err != nil {
				t.Error(err)
				return
			}
			if err = j.end(c, true, ""); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	rs := records(t, b)
	if len(rs) != 200 {
		t.Fatal(len(rs))
	}
	pending := map[string]string{}
	for _, r := range rs {
		if r.Phase == "begin" {
			if pending[r.ID] != "" {
				t.Fatal("duplicate begin")
			}
			pending[r.ID] = r.RequestSHA256
		} else {
			if pending[r.ID] != r.RequestSHA256 {
				t.Fatal("unmatched end")
			}
			delete(pending, r.ID)
		}
	}
	if len(pending) != 0 {
		t.Fatal("incomplete journal")
	}
}
