package execution

import "context"

type PinnedFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}
type Runtime struct {
	Engine        PinnedFile  `json:"engine"`
	Runner        PinnedFile  `json:"runner"`
	Supervisor    PinnedFile  `json:"supervisor"`
	Shim          PinnedFile  `json:"shim"`
	Recorder      PinnedFile  `json:"recorder"`
	Plugin        PinnedFile  `json:"plugin"`
	PatchSHA256   string      `json:"patchSha256"`
	EntitlementCA *PinnedFile `json:"entitlementCA,omitempty"`
}
type RunContext struct {
	Host         string `json:"host"`
	Organization string `json:"organization"`
	Token        string `json:"token"`
}
type Config struct {
	engineTemp        string
	ParentPID         int               `json:"parentPid,omitempty"`
	ExecutionID       string            `json:"executionId,omitempty"`
	SchemaVersion     int               `json:"schemaVersion"`
	Runtime           Runtime           `json:"runtime"`
	RunID             string            `json:"runId"`
	WorkspaceID       string            `json:"workspaceId"`
	Command           string            `json:"command"`
	WorkDirectory     string            `json:"workDirectory"`
	WorkRoot          string            `json:"workRoot,omitempty"`
	PrivateParent     string            `json:"privateParent"`
	CgroupRoot        string            `json:"cgroupRoot"`
	PolicyRoots       []string          `json:"policyRoots"`
	Environment       map[string]string `json:"environment"`
	Arguments         []string          `json:"arguments"`
	Overrides         []Override        `json:"overrides,omitempty"`
	RunContext        *RunContext       `json:"runContext,omitempty"`
	SavedPlan         *PinnedFile       `json:"savedPlan,omitempty"`
	TimeoutSeconds    int               `json:"timeoutSeconds"`
	ReceiptKey        string            `json:"receiptKey"`
	EvaluationID      string            `json:"evaluationId"`
	PolicyFingerprint string            `json:"policyFingerprint"`
	PlanReceipt       *Receipt          `json:"planReceipt,omitempty"`
}
type Result struct {
	SchemaVersion        int      `json:"schemaVersion"`
	RunID                string   `json:"runId"`
	WorkspaceID          string   `json:"workspaceId"`
	Command              string   `json:"command"`
	Nonce                string   `json:"nonce"`
	Directory            string   `json:"directory"`
	ExitCode             int      `json:"exitCode"`
	CgroupEmpty          bool     `json:"cgroupEmpty"`
	Cancelled            bool     `json:"cancelled"`
	Verified             bool     `json:"verified"`
	Evidence             Evidence `json:"evidence"`
	PlanJSONSHA256       string   `json:"planJsonSha256,omitempty"`
	PlanSHA256           string   `json:"planSha256,omitempty"`
	PolicySnapshotSHA256 string   `json:"policySnapshotSha256,omitempty"`
	RuntimeSHA256        string   `json:"runtimeSha256,omitempty"`
	StdoutSHA256         string   `json:"stdoutSha256,omitempty"`
	AuditSHA256          string   `json:"auditSha256,omitempty"`
	JournalSHA256        string   `json:"journalSha256,omitempty"`
	Receipt              *Receipt `json:"receipt,omitempty"`
}

// Execute runs init, plan or saved-plan apply. This module verifies the local
// stage and seals run/snapshot-bound plan admission for saved apply.
func Execute(ctx context.Context, c Config) (Result, error) { return execute(ctx, c) }

func Probe(ctx context.Context, c Config) error { return probe(ctx, c) }
