# Terraform policy runtime status

Terrence supports opt-in native Terraform policy (`kind = "tfpolicy"`) execution for hosted runs and matching agents advertising `operation.native-policy.v2`. An operator-managed runtime profile, the strict Terraform 1.17.1 reference engine, a separately supplied licensed tfpolicy-plugin and the required Linux isolation are mandatory. Unconfigured hosts and legacy agents remain blocked when a native policy set applies.

See [build, configuration and recovery instructions](https://github.com/essinghigh-org/terrence/blob/master/tools/tfpolicy-engine/HANDOFF.md) for the complete runtime profile and matching-agent setup. Provider schema or API coverage alone does not establish runtime support.

## Configuration and source admission

- Configure `TERRENCE_TFPOLICY_RUNTIME_PROFILE` on the server. Matching agents also need `TERRENCE_AGENT_NATIVE_POLICY_PROFILE` on the agent host and `TERRENCE_AGENT_SANDBOX=true`. Their runtime bytes must match the server's pins; local paths may differ.
- Use Linux with Landlock ABI 6 or later, a non-root service with zero capabilities, and a delegated cgroup v2 hierarchy with finite memory/PID limits. The owner does not change host security settings to satisfy these requirements.
- Pin the engine, owner, runner, supervisor, shim, recorder and operator plugin. The enabled admin catalog must contain the matching Linux architecture and archive checksum. Archive and extracted-executable checksums identify different files.
- Supply a ready native policy archive. `policiesPath` must stay inside the archive and directly contain `.policy.hcl` files. Native sources remain native archives; they do not create synthetic Sentinel/OPA policy rows.
- Select the installed plugin version explicitly, or use an omitted/`latest` tool selection that resolves to it through `.tfpolicy-version` or the latest enabled stable catalog entry. A conflicting version is rejected. The API accepts `managed`, but the native runtime does not resolve it to an installed version; use an explicit matching version instead.
- Use Terraform 1.17.1 workspaces. A workspace version selection of `latest` still uses the pinned strict 1.17.1 runtime for native work, not an arbitrary downloaded engine. Changing runtime bytes, policy sources or the saved plan invalidates prior admission and requires a fresh plan.

Registering a catalog version, installing a plugin on PATH, or setting Terraform's `TF_POLICY_PLUGIN` environment variable alone does not enable execution. Do not remove enforcement guards to bypass runtime admission.

## Enforcement and recovery

Hosted and capable-agent paths run native init, plan and saved-plan apply through the execution owner. The owner checks strict engine evidence, expected target coverage and complete matched RPC results. Authenticated receipts bind the run, workspace, evaluation generation, policy snapshot, runtime and saved plan. Agent receipts additionally bind the job, lease and exit disposition. A successful transport handshake or an older successful plan is insufficient.

Advisory policy denials are non-blocking. Mandatory denials block apply, while `mandatory_overridable` denials require authorized approval in the same evaluation generation. The native policy's enforcement level controls this behavior; the policy-set API still rejects `agent_enabled` and `overridable` for `kind = "tfpolicy"`. Runtime errors and incomplete evidence cannot be overridden. Unknown initialization inputs may be deferred to plan, but unresolved required plan/apply results block admission.

Apply-time policy or runtime failures can occur after infrastructure changes. Terrence preserves actual state and reports failure; this is not rollback. Interrupted native agent applies retain their workspace lock and execution directory until fenced state recovery is durably acknowledged. They are not automatically replayed. Follow the [recovery procedure](https://github.com/essinghigh-org/terrence/blob/master/tools/tfpolicy-engine/HANDOFF.md#release-and-recovery) before deleting retained state or starting another apply.

## Unsupported execution

The following remain blocked for applicable native policies:

- OpenTofu, stock Terraform and Terraform versions other than the configured strict 1.17.1 engine.
- Stack deployments, even though Stack policy-set scoping is represented in the provider/API.
- Legacy agents and hosts without a valid configured runtime.
- Native policy-set parameters, targeted plans (`-target`), action-only runs and deny-network execution.
- Missing, changed or unready source archives, mismatched catalog/tool versions, and missing or invalid admission evidence.

There is no silent fallback to another engine or policy evaluator. Runtime admission and apply checks remain necessary because policies and execution conditions can change between stages.

## Bring your own binary

Operators obtain and supply the licensed **tfpolicy-plugin** executable. The separate `tfpolicy` authoring CLI cannot substitute for this execution plugin. Terrence does not bundle or redistribute the proprietary plugin or a compiled Terraform executable. The source build recipe retains Terraform's BUSL-1.1 terms; operators must review the terms applicable to their use and distribution.

## Native API entitlement

The organization entitlement-set response includes `tf-policy-enforcement`, the distinct JSON:API attribute read by tfpolicy-plugin 0.5.0 during native Setup. It follows the site's policy-enforcement entitlement. The generic `policy-enforcement` and `sentinel` attributes do not satisfy that check. A private run-scoped token provides genuine entitlement context and is revoked after each stage. This API field alone does not bypass runtime admission.

## Why the strict engine is required

Stock Terraform 1.17.1's apply command logs policy-client initialization errors and can continue applying. A missing executable, failed handshake or Setup failure could therefore allow an apply without enforcement. Preflight or log monitoring cannot guarantee a barrier before resource mutation.

The stock [Policy RPC](https://github.com/hashicorp/terraform/blob/ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9/internal/policy/proto/policy.proto) also lacks a trusted expected target inventory and stage-completion manifest. A journal containing only successful observed requests cannot prove complete policy coverage. Terrence's strict engine adds protected inventory and phase evidence; the owner independently checks it against the saved plan and RPC journal before accepting admission. Stock Terraform cannot substitute for that build.

## Qualification evidence

The [final implementation head](https://github.com/essinghigh-org/terrence/commit/1fa531dcb3c85ae26922c113463d9def34ecc92e) passed [full CI](https://github.com/essinghigh-org/terrence/actions/runs/42437736911) and [both native qualification lanes](https://github.com/essinghigh-org/terrence/actions/runs/42437736865) before merging in #1070. Each native lane ran the strict-owner matrix without skipping, eight official-plugin hosted-worker cases and six production API/agent cases with agent revision `369e5cb7cbf07a0f83e5d996d72bb5a5ce78668b`. Failure and process-death cases required preservation of all 200 local test resources. The agent override case simulates an already approved check; it verifies execution after approval, not approval authorization.

The workflow verifies official plugin downloads using signed checksums. Its pinned lane gates the workflow; latest is advisory for pull requests but fails scheduled and manual runs on regression. Weekly runs are scheduled for Tuesday at 06:47 UTC. These are functional compatibility tests of specific versions and cases, not universal parity, performance or license-rights guarantees. See [official-plugin CI details](https://github.com/essinghigh-org/terrence/blob/master/tools/tfpolicy-engine/HANDOFF.md#official-plugin-ci).

The separate [stock-engine transport harness](https://github.com/essinghigh-org/terrence/blob/master/tools/tfpolicy-supervisor/integration/README.md) uses an original protocol fixture and always reports `admitted: false`. It qualifies transport, isolation and lifecycle behavior only. Do not confuse its fixture results with the real-plugin production-worker and agent evidence above. Missing native prerequisites are reported as not run and fail qualification, never as a pass.

## Upstream references

- [Terraform 1.17.0 release notes](https://github.com/hashicorp/terraform/blob/v1.17.0/CHANGELOG.md)
- [Terraform 1.17.1 apply command](https://github.com/hashicorp/terraform/blob/v1.17.1/internal/command/apply.go)
- [Native policy client](https://github.com/hashicorp/terraform/blob/v1.17.1/internal/policy/client.go)
- [Terraform Enterprise plugin version administration](https://developer.hashicorp.com/terraform/enterprise/application-administration/terraform-policy-tool-versions)
