// Research-only transparent RPC relay. Not part of any production build.
package recordingproxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"

	p "github.com/hashicorp/terraform/internal/policy/proto"
	pb "google.golang.org/protobuf/proto"
)

type Event struct {
	Sequence            int
	Method, RequestHash string
	Finished            bool
	Failed              bool
	Result              p.EvaluateResult
}
type Journal struct {
	mu           sync.Mutex
	events       []Event
	ready        bool
	failed       bool
	setupStarted bool
}

func (j *Journal) begin(method string, req pb.Message) int {
	data, _ := pb.MarshalOptions{Deterministic: true}.Marshal(req)
	sum := sha256.Sum256(data)
	j.mu.Lock()
	defer j.mu.Unlock()
	n := len(j.events)
	j.events = append(j.events, Event{Sequence: n, Method: method, RequestHash: hex.EncodeToString(sum[:])})
	return n
}
func (j *Journal) end(n int, result p.EvaluateResult, failed bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.events[n].Finished = true
	j.events[n].Result = result
	j.events[n].Failed = failed
	j.failed = j.failed || failed
}
func (j *Journal) Snapshot() []Event {
	j.mu.Lock()
	defer j.mu.Unlock()
	return append([]Event(nil), j.events...)
}

// Validate only establishes recorder completion and exact supplied inventory.
// It is NOT proof Terraform exited, consumed the plugin, or used the saved plan.
func (j *Journal) Validate(expected map[string]int) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.ready || j.failed {
		return errors.New("setup or RPC failed")
	}
	actual := map[string]int{}
	for _, e := range j.events {
		if !e.Finished || e.Failed {
			return errors.New("incomplete RPC")
		}
		if e.Method == "Setup" || e.Method == "GetResources" || e.Method == "GetDataSource" {
			continue
		}
		if e.Result != p.EvaluateResult_ALLOW_EVALUATE_RESULT {
			return errors.New("non-allow aggregate result")
		}
		actual[e.Method+":"+e.RequestHash]++
	}
	if expected == nil {
		return errors.New("authoritative inventory missing")
	}
	if len(actual) != len(expected) {
		return errors.New("inventory mismatch")
	}
	for k, n := range expected {
		if n < 1 || actual[k] != n {
			return errors.New("inventory mismatch")
		}
	}
	return nil
}

type Proxy struct {
	p.UnimplementedPolicyServer
	Client  p.PolicyClient
	Journal *Journal
	// The broker adapter must register a downstream callback service forwarding
	// to the original upstream ID, and return its new downstream service ID.
	Bridge func(context.Context, uint32) (uint32, error)
}

func (s *Proxy) Setup(ctx context.Context, req *p.PolicySetupRequest) (*p.PolicySetupResponse, error) {
	s.Journal.mu.Lock()
	if s.Journal.setupStarted {
		s.Journal.failed = true
		s.Journal.mu.Unlock()
		return nil, errors.New("duplicate Setup")
	}
	s.Journal.setupStarted = true
	s.Journal.mu.Unlock()
	// Never record entitlement credentials, even hashed.
	sanitized := pb.Clone(req).(*p.PolicySetupRequest)
	sanitized.Entitlement = nil
	n := s.Journal.begin("Setup", sanitized)
	copied := pb.Clone(req).(*p.PolicySetupRequest)
	var err error
	copied.CallbackService, err = s.Bridge(ctx, req.CallbackService)
	if err != nil {
		s.Journal.end(n, 0, true)
		return nil, err
	}
	resp, err := s.Client.Setup(ctx, copied)
	failed := err != nil || resp == nil
	if resp != nil {
		for _, d := range resp.Diagnostics {
			if d.Severity != p.Severity_WARNING {
				failed = true
			}
		}
	}
	s.Journal.end(n, 0, failed)
	s.Journal.mu.Lock()
	s.Journal.ready = !failed
	s.Journal.mu.Unlock()
	return resp, err
}
func (s *Proxy) admitted() error {
	s.Journal.mu.Lock()
	defer s.Journal.mu.Unlock()
	if !s.Journal.ready {
		s.Journal.failed = true
		return errors.New("Setup not ready")
	}
	return nil
}
func (s *Proxy) EvaluateResource(ctx context.Context, req *p.PolicyEvaluateResourceRequest) (*p.PolicyEvaluateResourceResponse, error) {
	if err := s.admitted(); err != nil {
		return nil, err
	}
	canonical := pb.Clone(req).(*p.PolicyEvaluateResourceRequest)
	canonical.EvaluationId = 0
	n := s.Journal.begin("EvaluateResource", canonical)
	resp, err := s.Client.EvaluateResource(ctx, req)
	var result p.EvaluateResult
	if resp != nil {
		result = resp.Result
	}
	failed := err != nil || resp == nil
	if resp != nil {
		failed = failed || badDetails(resp.PolicyDetails)
	}
	s.Journal.end(n, result, failed)
	return resp, err
}
func (s *Proxy) EvaluateProvider(ctx context.Context, req *p.PolicyEvaluateProviderRequest) (*p.PolicyEvaluateProviderResponse, error) {
	if err := s.admitted(); err != nil {
		return nil, err
	}
	n := s.Journal.begin("EvaluateProvider", req)
	resp, err := s.Client.EvaluateProvider(ctx, req)
	var result p.EvaluateResult
	if resp != nil {
		result = resp.Result
	}
	failed := err != nil || resp == nil
	if resp != nil {
		failed = failed || badDetails(resp.PolicyDetails)
	}
	s.Journal.end(n, result, failed)
	return resp, err
}
func (s *Proxy) EvaluateModule(ctx context.Context, req *p.PolicyEvaluateModuleRequest) (*p.PolicyEvaluateModuleResponse, error) {
	if err := s.admitted(); err != nil {
		return nil, err
	}
	n := s.Journal.begin("EvaluateModule", req)
	resp, err := s.Client.EvaluateModule(ctx, req)
	var result p.EvaluateResult
	if resp != nil {
		result = resp.Result
	}
	failed := err != nil || resp == nil
	if resp != nil {
		failed = failed || badDetails(resp.PolicyDetails)
	}
	s.Journal.end(n, result, failed)
	return resp, err
}

// Callback forwarding retains Terraform's own typed provider and graph logic.
// No callback result is substituted, re-evaluated or persisted by this relay.
func badDetails(details []*p.PolicyEvaluationDetail) bool {
	for _, d := range details {
		if d == nil || d.Result != p.EvaluateResult_ALLOW_EVALUATE_RESULT {
			return true
		}
		for _, diag := range d.Diagnostics {
			if diag == nil || diag.Severity != p.Severity_WARNING {
				return true
			}
		}
		for _, e := range d.EnforceResults {
			if e == nil || e.Result != p.EvaluateResult_ALLOW_EVALUATE_RESULT {
				return true
			}
			for _, diag := range e.Diagnostics {
				if diag == nil || diag.Severity != p.Severity_WARNING {
					return true
				}
			}
		}
	}
	return false
}

type CallbackRelay struct {
	p.UnimplementedCallbackServiceServer
	Client  p.CallbackServiceClient
	Journal *Journal
}

func (s *CallbackRelay) GetResources(c context.Context, r *p.GetResourcesRequest) (*p.GetResourcesResponse, error) {
	n := s.Journal.begin("GetResources", r)
	v, e := s.Client.GetResources(c, r)
	failed := e != nil || v == nil
	if v != nil {
		failed = failed || v.Partial
	}
	s.Journal.end(n, 0, failed)
	return v, e
}
func (s *CallbackRelay) GetDataSource(c context.Context, r *p.GetDataSourceRequest) (*p.GetDataSourceResponse, error) {
	n := s.Journal.begin("GetDataSource", r)
	v, e := s.Client.GetDataSource(c, r)
	failed := e != nil || v == nil
	if v != nil {
		failed = failed || v.Deferred
	}
	s.Journal.end(n, 0, failed)
	return v, e
}

var _ p.PolicyServer = (*Proxy)(nil)
var _ p.CallbackServiceServer = (*CallbackRelay)(nil)
