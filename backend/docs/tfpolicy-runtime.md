# Terraform policy runtime status

Terrence accepts Terraform policy (`kind = "tfpolicy"`) policy-set configuration and the administrator's plugin version catalog. **It does not yet execute tfpolicy policies.** An applicable tfpolicy set blocks hosted runs, agent runs, and Stack deployments. Hosted plan entry and agent plan admission reject unsupported policy execution before source preparation or execution data handoff; agent redelivery and artifact downloads recheck admission. Completion and apply checks remain necessary because policy scope can change during execution. A successful older plan does not bypass this restriction.

## Bring your own binary

The intended distribution model is an operator-provided **tfpolicy-plugin** executable, like the existing Sentinel approach. Terrence must not bundle or redistribute this proprietary binary. The separate `tfpolicy` authoring CLI is not the execution plugin and cannot substitute for it. Operators are responsible for obtaining the runtime and the rights required for their use. Publicly downloadable does not mean unrestricted redistribution or use.

Registering a version in the admin catalog, installing a plugin on PATH, or setting Terraform's `TF_POLICY_PLUGIN` environment variable does **not** enable tfpolicy execution in Terrence. Do not remove the enforcement guards to enable it.

## Why simply invoking the plugin is unsafe

Terraform 1.17 promotes native policy flags to general availability. However, Terraform 1.17.1's apply command explicitly logs policy-client initialization errors and continues the apply operation. A missing executable, failed handshake, callback setup failure, or plugin setup error can therefore result in an apply without policy enforcement. A separate successful preflight does not guarantee that the later apply process initializes successfully. Watching logs and killing the process is not a reliable barrier before infrastructure mutation.

The native engine also evaluates initialization, plan, and apply stages, including deferred values and Terraform callbacks. Replaying plan JSON through the authoring CLI would not implement this contract.

The pinned [native Policy RPC](https://github.com/hashicorp/terraform/blob/ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9/internal/policy/proto/policy.proto) provides Setup and individual resource/provider/module evaluations. It does not provide a trusted expected evaluation inventory or a stage-completion manifest. Resource requests identify a resource type and module path, rather than an absolute instance address; evaluation IDs are assigned dynamically by the engine. A complete journal of observed requests therefore cannot prove that every required target was evaluated. Signing that journal, or checking its last successful result, would authenticate incomplete evidence. Production admission needs a verified complete inventory and stage contract, in addition to authenticating the owner process and saved plan.

## Qualification evidence

The source-only [native qualification harness](../../tools/tfpolicy-supervisor/integration/README.md) passed its [21-case hosted matrix](https://github.com/essinghigh-org/terrence/actions/runs/42309733910), using official Terraform 1.17.1 and an original test-only protocol fixture. It verifies confinement, startup/RPC failure reporting, cancellation, cgroup cleanup and preservation of local state after apply-time failure. Every case reports `admitted: false`. This qualifies the tested transport and lifecycle behavior; it does not establish real-plugin acceptance, complete policy coverage, a production admission receipt, or permission to use or redistribute the proprietary runtime. An operator-supplied executable still requires applicable licensing and separate real-plugin tests.

## Requirements before enabling execution

- A verified same-process fail-closed contract before any apply mutation, including plugin startup and subsequent RPC failures. Missing, failed, unknown, or incomplete mandatory evaluation must not authorize apply.
- A trusted expected policy/target inventory and stage-completion contract, so omitted evaluations cannot appear successful merely because all observed RPCs completed.
- Immutable source snapshots and inputs, with safe archive extraction and confined policy paths. VCS source ingestion must not manufacture Sentinel or OPA policy rows.
- Run-pinned enabled plugin versions, architecture checksums, and `.tfpolicy-version` resolution. Mount operator-provided binaries inside the existing execution sandbox. Do not silently fall back to another engine.
- Native init/plan/saved-plan apply integration with stage-specific results, diagnostics, advisory/mandatory semantics, and deferred/post-apply outcomes.
- Equivalent behavior for hosted and agent execution. OpenTofu, older Terraform versions, and Stack execution remain blocked until independently supported and tested.
- Real integration tests for allow/deny/unknown results, missing or crashing plugins, setup and callback errors, source changes between stages, and retry/agent execution. Mock tests alone cannot establish native compatibility.

## Upstream references

- [Terraform 1.17.0 release notes](https://github.com/hashicorp/terraform/blob/v1.17.0/CHANGELOG.md)
- [Terraform 1.17.1 apply command](https://github.com/hashicorp/terraform/blob/v1.17.1/internal/command/apply.go)
- [Native policy client](https://github.com/hashicorp/terraform/blob/v1.17.1/internal/policy/client.go)
- [Terraform Enterprise plugin version administration](https://developer.hashicorp.com/terraform/enterprise/application-administration/terraform-policy-tool-versions)
