# Native policy execution handoff

This is an incomplete implementation of #1056. Terrence still rejects native policy execution. Do not remove the hosted or agent guards just because this engine can evaluate policies.

## What works

- The plugin 0.5.0 entitlement check requires the JSON:API `tf-policy-enforcement` attribute. Terrence now exposes it through the canonical organization entitlement route; merged PR #1069 contains that compatibility fix.
- `build.sh` applies the accompanying patch to official Terraform 1.17.1 commit `ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9`, runs policy tests, and produces an operator-built static Linux executable with provenance and the upstream license. No proprietary binary is included.
- The opt-in `-strict-policy` path rejects missing owner evidence, startup failures, mandatory denials and unresolved mandatory results. Ordinary upstream CLI behavior is preserved outside this flag. Known direct-apply denials run before resource changes; failures after apply retain actual state.
- A protected pipe carries Setup, graph target inventories, exact evaluation request digests, policy classifications, phase endings and command exit. It closes on exec before descendants start. Missing, duplicate or unbound evaluations poison completion.

## Validation performed

The recipe completed with Go 1.26.10. Its policy tests passed in `internal/command`, `internal/terraform` and `internal/policy` (the last package had no matching tests). `git diff --check` passed for the patched upstream source.

Reference build identity:

```
source: ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9
patch:  be18eb7f9e17b235b6fb390f637fbaa7f49d9ed71521d8718ac730a1133e3a27
engine: 927b7a59ebc3961064e1af879c0c69c9c5d30cd4c0c32cbaf9c4379e1d8ace55
plugin: 848def9140e35359779fe5b380231b31301a741118a3c985217cc99cdbaa5e4f
```

A private local acceptance harness ran this exact build with the operator-supplied, unmodified plugin 0.5.0 and the real Terrence entitlement route. All 12 behavioral cases passed:

| Operation | Cases |
| --- | --- |
| Plan | allow; valid filter/no match; deny; unresolved mandatory; missing executable; invalid policy Setup |
| Saved-plan apply | allow, using the byte-identical saved plan |
| Direct apply | allow; valid filter/no match; deny; missing executable; invalid policy Setup |

Denied and failed direct applies created no managed resource state. Positive applies retained state. Each case used only the built-in `terraform_data` resource, temporary local state, Landlock with tracing/debug syscalls denied, zero process capabilities and a finite owned cgroup. Cleanup verified empty cgroups; API credentials were revoked. Saved-plan JSON inspection used a read-only plan after engine/recorder exit and checked its digest before and after inspection.

These are behavioral observations, not production admission. The private harness and proprietary binary are not repository fixtures. Tests in the patch cover classifications, audit ordering/completeness, pipe failures, and unowned CLI invocation. A previous private prototype additionally demonstrated post-apply denial retaining state; that is not acceptance evidence for this exact final reference build.

## Remaining work, in dependency order

1. **Trusted execution owner.** Build a reusable owner around the existing `tools/tfpolicy-supervisor`, shim and recorder. Pin and verify the actual engine, runner, recorder, shim and BYOB executable; probe the engine contract; reject nonzero capabilities, missing isolation or nonfinite/undelegated cgroups. Gate the engine before execution, own cleanup and cancellation, and drain bounded private evidence before admitting completion. No stock-engine or simulated fallback.
2. **Entitlement delivery.** The private harness supplied genuine run context through a recorder prototype. The committed recorder forwards native Setup unchanged. Implement protected production delivery of the Terrence host, organization and run-scoped token; keep it out of workspace files, command arguments, public logs and descendants. The source build alone does not provide this delivery path.
3. **Independent coverage and receipt.** Match protected resource target inventories to the immutable saved plan's resource changes, including no-op, replacement, destroy and refresh-only cases. Graph self-registration cannot detect omission of an entire registration. Join every native request digest to a complete recorder RPC journal, including callback failures. Bind run/workspace, policy snapshot, runtime identity, stage, saved-plan digest, actual exit/output and cleanup/cancellation outcome in an authenticated receipt outside the sandbox. Do not treat an ALLOW journal or an unsigned transport status as admission.
4. **Policy snapshot and versions.** Ingest native policy-set archives without manufacturing OPA/Sentinel policy rows. Resolve and pin the selected policy-set version, source digest, native tool version and operator executable. Include archive/catalog changes in the policy fingerprint. Review `policy-sync.ts`, policy-set version upload routes, `adminTfpolicyVersions` and `.tfpolicy-version` selection.
5. **Hosted integration.** Wire strict init/plan and immutable saved-plan apply into `worker.ts`. Consume the receipt in `workspace-policy-gate.ts`, persist native policy results and allowed overrides, and preserve state on post-apply failure or interruption. Source guards must remain until this path is complete.
6. **Explicitly capable agents.** Extend `agent-protocol.ts` and `agent-jobs.ts` with an explicit verified native capability and snapshot/artifact contract. Legacy agents must continue to reject native policy work before receiving source or credentials. Add matching agent execution and result verification.
7. **Acceptance and docs.** Add reproducible real-engine tests for RPC failure, in-flight cancellation, omitted/truncated evidence, stage mismatch, stale snapshots, changed saved plans, advisory/override behavior, provider/module policies, and post-apply failures retaining state. Port the successful local cases into that harness. Document operator configuration and runtime readiness only after both hosted and agent paths are verified. Review distribution terms before publishing any linked binary; retain Terraform's BUSL-1.1 notices and require operators to supply their licensed plugin.

Useful existing entry points: `backend/src/worker.ts` (`runPlanInitAndPlan`, `runPlanFinalizeStages`, `runApplyInit`), `backend/src/lib/workspace-policy-gate.ts`, `backend/src/lib/policy-sync.ts`, `backend/src/lib/run-cgroup.ts`, `tools/tfpolicy-supervisor/internal/bootstrap`, and `tools/tfpolicy-recorder`. Existing general cgroup helpers deliberately degrade gracefully; strict native admission must verify prerequisites rather than inherit that fallback.

The engine patch and build recipe are ready for review. #1056 remains open; no runtime is activated by this change.
