package recorder

import (
	"context"
	"errors"
	p "github.com/hashicorp/terraform/internal/policy/proto"
	pb "google.golang.org/protobuf/proto"
)

type Proxy struct {
	p.UnimplementedPolicyServer
	Client  p.PolicyClient
	Journal *Journal
	Bridge  func(context.Context, uint32) (uint32, error)
	// Exact source directories supplied by the trusted snapshot supervisor.
	PolicyRoots []string
	RunContext  *RunContext
}

func (s *Proxy) Setup(ctx context.Context, req *p.PolicySetupRequest) (*p.PolicySetupResponse, error) {
	if req == nil {
		return nil, errors.New("missing Setup request")
	}
	sanitized := pb.Clone(req).(*p.PolicySetupRequest)
	sanitized.Entitlement = nil
	c, err := s.Journal.begin("Setup", sanitized)
	if err != nil {
		return nil, err
	}
	fail := func(message string) (*p.PolicySetupResponse, error) {
		if e := s.Journal.end(c, false, message); e != nil {
			return nil, e
		}
		return nil, errors.New(message)
	}
	if !s.Journal.startSetup() {
		return fail("duplicate Setup")
	}
	if len(req.SourceLocations) != len(s.PolicyRoots) || len(s.PolicyRoots) == 0 {
		return fail("policy source identity mismatch")
	}
	for i, path := range s.PolicyRoots {
		if req.SourceLocations[i] != path {
			return fail("policy source identity mismatch")
		}
	}
	copied := pb.Clone(req).(*p.PolicySetupRequest)
	if s.RunContext != nil {
		if err := s.RunContext.validate(); err != nil {
			return fail("invalid trusted run context")
		}
		// Only this private supervisor-owned identity may supply local-backend
		// credentials. Do not mutate the original request or its sanitized hash.
		copied.Entitlement = &p.PolicySetupRequest_Entitlement{Host: s.RunContext.Host, Org: s.RunContext.Organization, Token: s.RunContext.Token}
	}
	copied.CallbackService, err = s.Bridge(ctx, req.CallbackService)
	if err != nil {
		return fail("callback bridge failed")
	}
	resp, err := s.Client.Setup(ctx, copied)
	failure := ""
	if err != nil || resp == nil {
		failure = "Setup RPC failed"
	} else if badDiagnostics(resp.Diagnostics) {
		failure = "Setup policy diagnostic error"
	}
	if e := s.Journal.end(c, false, failure); e != nil {
		return nil, e
	}
	s.Journal.setReady(failure == "")
	return resp, err
}
func (s *Proxy) EvaluateResource(ctx context.Context, req *p.PolicyEvaluateResourceRequest) (*p.PolicyEvaluateResourceResponse, error) {
	if req == nil {
		return nil, errors.New("missing evaluation request")
	}
	c, err := s.Journal.begin("EvaluateResource", req)
	if err != nil {
		return nil, err
	}
	if !s.Journal.admitted() || !s.Journal.startEvaluation(req.EvaluationId) {
		_ = s.Journal.end(c, false, "evaluation before setup or duplicate correlation")
		return nil, errors.New("evaluation not admitted")
	}
	defer s.Journal.finishEvaluation(req.EvaluationId)
	resp, err := s.Client.EvaluateResource(ctx, req)
	result := p.EvaluateResult(0)
	var details []*p.PolicyEvaluationDetail
	if resp != nil {
		result = resp.Result
		details = resp.PolicyDetails
	}
	if e := s.Journal.end(c, result == p.EvaluateResult_ALLOW_EVALUATE_RESULT, evaluationFailure(err, resp == nil, result, details)); e != nil {
		return nil, e
	}
	return resp, err
}
func (s *Proxy) EvaluateProvider(ctx context.Context, req *p.PolicyEvaluateProviderRequest) (*p.PolicyEvaluateProviderResponse, error) {
	if req == nil {
		return nil, errors.New("missing evaluation request")
	}
	c, err := s.Journal.begin("EvaluateProvider", req)
	if err != nil {
		return nil, err
	}
	if !s.Journal.admitted() {
		_ = s.Journal.end(c, false, "evaluation before setup")
		return nil, errors.New("evaluation not admitted")
	}
	resp, err := s.Client.EvaluateProvider(ctx, req)
	result := p.EvaluateResult(0)
	var details []*p.PolicyEvaluationDetail
	if resp != nil {
		result = resp.Result
		details = resp.PolicyDetails
	}
	if e := s.Journal.end(c, result == p.EvaluateResult_ALLOW_EVALUATE_RESULT, evaluationFailure(err, resp == nil, result, details)); e != nil {
		return nil, e
	}
	return resp, err
}
func (s *Proxy) EvaluateModule(ctx context.Context, req *p.PolicyEvaluateModuleRequest) (*p.PolicyEvaluateModuleResponse, error) {
	if req == nil {
		return nil, errors.New("missing evaluation request")
	}
	c, err := s.Journal.begin("EvaluateModule", req)
	if err != nil {
		return nil, err
	}
	if !s.Journal.admitted() {
		_ = s.Journal.end(c, false, "evaluation before setup")
		return nil, errors.New("evaluation not admitted")
	}
	resp, err := s.Client.EvaluateModule(ctx, req)
	result := p.EvaluateResult(0)
	var details []*p.PolicyEvaluationDetail
	if resp != nil {
		result = resp.Result
		details = resp.PolicyDetails
	}
	if e := s.Journal.end(c, result == p.EvaluateResult_ALLOW_EVALUATE_RESULT, evaluationFailure(err, resp == nil, result, details)); e != nil {
		return nil, e
	}
	return resp, err
}
func evaluationFailure(err error, missing bool, result p.EvaluateResult, details []*p.PolicyEvaluationDetail) string {
	if err != nil || missing {
		return "evaluation RPC failed"
	}
	if result != p.EvaluateResult_ALLOW_EVALUATE_RESULT {
		return "policy aggregate denied or unknown"
	}
	if badDetails(details) {
		return "policy detail denied, unknown, or diagnostic error"
	}
	return ""
}
func badDiagnostics(ds []*p.Diagnostic) bool {
	for _, d := range ds {
		if d == nil || d.Severity != p.Severity_WARNING {
			return true
		}
	}
	return false
}
func badDetails(ds []*p.PolicyEvaluationDetail) bool {
	for _, d := range ds {
		if d == nil || d.Result != p.EvaluateResult_ALLOW_EVALUATE_RESULT || badDiagnostics(d.Diagnostics) {
			return true
		}
		for _, e := range d.EnforceResults {
			if e == nil || e.Result != p.EvaluateResult_ALLOW_EVALUATE_RESULT || badDiagnostics(e.Diagnostics) {
				return true
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

func (s *CallbackRelay) GetResources(ctx context.Context, req *p.GetResourcesRequest) (*p.GetResourcesResponse, error) {
	if req == nil {
		return nil, errors.New("missing callback request")
	}
	c, err := s.Journal.begin("GetResources", req)
	if err != nil {
		return nil, err
	}
	if !s.Journal.callbackAllowed(req.EvaluationRequestId) {
		_ = s.Journal.end(c, false, "callback correlation mismatch")
		return nil, errors.New("callback correlation mismatch")
	}
	resp, err := s.Client.GetResources(ctx, req)
	failure := ""
	if err != nil || resp == nil {
		failure = "callback RPC failed"
	} else if resp.Partial {
		failure = "partial callback result"
	}
	if e := s.Journal.end(c, false, failure); e != nil {
		return nil, e
	}
	return resp, err
}
func (s *CallbackRelay) GetDataSource(ctx context.Context, req *p.GetDataSourceRequest) (*p.GetDataSourceResponse, error) {
	if req == nil {
		return nil, errors.New("missing callback request")
	}
	c, err := s.Journal.begin("GetDataSource", req)
	if err != nil {
		return nil, err
	}
	if !s.Journal.callbackAllowed(req.EvaluationRequestId) {
		_ = s.Journal.end(c, false, "callback correlation mismatch")
		return nil, errors.New("callback correlation mismatch")
	}
	resp, err := s.Client.GetDataSource(ctx, req)
	failure := ""
	if err != nil || resp == nil {
		failure = "callback RPC failed"
	} else if resp.Deferred {
		failure = "deferred callback result"
	}
	if e := s.Journal.end(c, false, failure); e != nil {
		return nil, e
	}
	return resp, err
}
