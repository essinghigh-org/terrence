# Native policy execution

Native tfpolicy execution supports hosted runs and explicitly capable agents. Both are opt-in through operator-managed runtime profiles. Legacy agents remain blocked.

## Implemented

- Strict Terraform 1.17.1 startup and phase completion, with protected audit and saved-plan pipes closed before provider/plugin execution. A stock engine is rejected.
- A Linux execution owner that pins the engine, runner, supervisor, shim, recorder and operator-supplied plugin; requires Landlock ABI 6, zero capabilities and a finite delegated cgroup; captures bounded evidence, cancels on execution-parent loss and verifies process-tree cleanup.
- Genuine run-scoped entitlement context delivered privately through the recorder. Tokens are revoked after each stage. An optional pinned public CA supports private TLS endpoints without disabling certificate validation.
- Independent resource/provider/module coverage from the saved plan configuration and embedded prior state, correlated with the protected inventory and complete RPC journal. Authenticated version-2 plan receipts bind the run, workspace, evaluation generation, policy fingerprint, runtime bytes, source snapshot, rendered plan JSON and exact saved-plan bytes. Agent stage receipts also bind the exact job, lease and exit disposition. Policy references use root-index/relative-path identities so local mount paths do not weaken or prevent source binding.
- Native policy archives and selected tool/catalog versions in policy snapshots. Native sources do not create synthetic OPA or Sentinel policy rows.
- Hosted init/plan and saved-plan apply through the owner. Native results are persisted as policy checks. Mandatory denials block apply; `mandatory_overridable` denials require approval in the same evaluation generation. Existing partial-state and interrupted-apply recovery handling is retained.
- The matching agent update advertises `operation.native-policy.v2` only after checking its immutable profile, native owner and state sandbox. Frozen policy sources, receipt keys and evidence stay outside the workspace snapshot; private endpoints require the owning authenticated agent and current lease. The server verifies the receipt and artifact hashes before accepting a plan or successful apply.
- Unconfigured hosts and legacy agents reject native policy work before source/credential handoff. A hosted receipt does not give a legacy agent a native capability. Lost or canceled admitted native applies hold their workspace lock until returned state is durably recovered; they are not automatically requeued.

No proprietary plugin or compiled Terraform executable is included. The entitlement compatibility change is already merged in #1069.

## Operator setup for local qualification

Use Linux with Landlock ABI 6 or later, cgroup v2 delegation with finite memory/PID limits, and a non-root service account with no effective, permitted, inheritable, ambient or bounding capabilities. The supervisor checks these prerequisites; the generic worker's optional sandbox fallback does not satisfy them.

Build the strict engine from official Terraform commit `ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9` using Go 1.26.10:

```sh
bash tools/tfpolicy-engine/build.sh /absolute/terraform-checkout /absolute/new-engine-directory
(cd tools/tfpolicy-supervisor && CGO_ENABLED=0 go build -trimpath -buildvcs=false -o /absolute/runtime/owner ./cmd/tfpolicy-owner)
(cd tools/tfpolicy-supervisor && CGO_ENABLED=0 go build -trimpath -buildvcs=false -o /absolute/runtime/supervisor ./cmd/tfpolicy-supervisor)
(cd tools/tfpolicy-supervisor && CGO_ENABLED=0 go build -trimpath -buildvcs=false -o /absolute/runtime/shim ./cmd/tfpolicy-shim)
bash tools/tfpolicy-recorder/build.sh /absolute/terraform-checkout /absolute/runtime/recorder
```

Build the native `landlock-runner` with `sh backend/bin/build-landlock-runner.sh`. Install the licensed operator plugin separately. Make every executable canonical, regular, non-writable and singly linked. Set up a short, service-owned 0700 private parent outside run workspaces; its absolute path must be at most 25 bytes because native transport uses Unix sockets. Give the worker its own delegated cgroup root, with the necessary controllers already enabled by the operator. No host-global cgroup, core-dump or kernel setting is changed by the owner.

Set `TERRENCE_TFPOLICY_RUNTIME_PROFILE` to the canonical path of a read-only JSON file:

```json
{
  "schemaVersion": 1,
  "owner": { "path": "/opt/native/owner", "sha256": "<owner SHA-256>" },
  "runtime": {
    "engine": { "path": "/opt/native/terraform", "sha256": "<engine SHA-256>" },
    "runner": { "path": "/opt/native/landlock-runner", "sha256": "<runner SHA-256>" },
    "supervisor": { "path": "/opt/native/supervisor", "sha256": "<supervisor SHA-256>" },
    "shim": { "path": "/opt/native/shim", "sha256": "<shim SHA-256>" },
    "recorder": { "path": "/opt/native/recorder", "sha256": "<recorder SHA-256>" },
    "plugin": { "path": "/opt/native/tfpolicy-plugin", "sha256": "<extracted executable SHA-256>" },
    "patchSha256": "<patch SHA-256 from engine provenance.json>"
  },
  "pluginVersion": "0.5.0",
  "catalogSha256": "<operator ZIP SHA-256 from the enabled catalog row>",
  "cgroupRoot": "/sys/fs/cgroup/terrence",
  "privateParent": "/run/tfp"
}
```

The catalog/archive digest and executable digest identify different files. The enabled tfpolicy catalog must contain the matching Linux architecture and ZIP digest. Optional `runtime.entitlementCA` has the same path/SHA-256 shape and accepts public certificates only. `PUBLIC_URL` must be the genuine HTTPS Terrence endpoint reachable from the plugin. Set `TERRENCE_RUN_CGROUP_ROOT` to the delegated hierarchy and install the runner through the existing worker configuration.

Use Terraform 1.17.1 workspaces. Attach a ready native policy-set archive whose selected `policyToolVersion` or `.tfpolicy-version` is the installed plugin version. `policiesPath` must contain `.policy.hcl` files. Native parameters, action-only runs, other engine versions, and the deny-network profile are rejected. The profile and binaries must stay identical between plan and apply; changes require a new plan.

For agents, set `TERRENCE_AGENT_NATIVE_POLICY_PROFILE` to the same profile shape on the agent host, and keep `TERRENCE_AGENT_SANDBOX=true`. The owner and runtime **bytes** must match the server's pins; local paths, `cgroupRoot` and `privateParent` may differ. The agent process must already be inside its delegated hierarchy. Its native path creates only bounded children of that hierarchy. `runtime.runner` is the backend's native helper; `TERRENCE_LANDLOCK_RUNNER` remains the helper built by the agent repository, used for state capture. Registration checks both execution paths. A configured but invalid profile stops registration; omitting it preserves the legacy capability baseline.

Terraform's upstream BUSL-1.1 applies to the patched reference build. Preserve upstream copyright/license notices and review the applicable distribution and commercial-use terms. The build recipe is not a grant to redistribute Terraform or the proprietary plugin. Operators supply their own licensed plugin.

## Validation

The final contract-v2 build used:

```
source: ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9
patch:  605cdcc5027022b3e640b6e5c3e817cac17377fe91ac4a8b9054284117c0345b
engine: 924358d459f962e07c8f6d7282c2114c9b02fa35d6958f2967352f28fc400951
plugin: 848def9140e35359779fe5b380231b31301a741118a3c985217cc99cdbaa5e4f
```

The recipe's upstream/additional policy tests and full planfile package passed. An added traversal regression failed on the pinned upstream implementation, which omitted grandchildren from module policy evaluation. The patch uses the recursive configuration traversal; the regression and real nested-module plan/apply now pass. Supervisor race tests/vet and recorder race tests passed. The related backend run had 70 passing tests, three optional external-engine tests skipped, and no failures. The latest policy/agent guard run passed 20 tests; the environment-documentation regression also passed. Backend typecheck and changed-file lint passed. The preceding full lint budget was zero warnings. CI passed on the preceding `a64650c` revision. The strict-owner CI step passed without skipping on `81b0260`.

`integration/real-owner.py` runs the unmodified operator binary against the real isolated Terrence API. Sixteen owner cases passed: allow, filter, advisory, override, mandatory deny, unresolved mandatory, invalid Setup, missing binary, actual plugin termination during a pending resource RPC, owner cancellation during a pending RPC, provider/nested-module policies (also deleting a removed nested module tree with an orphan provider and matched delete policies), saved apply after relocating source and shim paths, and four mixed known-denial/required-unknown init cases (both policy orders and required enforcement levels). Positive saved applies retained state; negative plans made no managed resources. The original protocol fixture separately covers post-apply denial, RPC crash and cancellation retaining state, orphan cleanup, and no-op/refresh-only/replacement/destroy resource coverage. Fixture results do not establish proprietary-plugin post-apply behavior.

The same harness with `--hosted-worker --plugin-archive /absolute/operator.zip` invokes the production worker and persisted policy gates through `backend/tests/compat/tfpolicy-owner/worker.ts`. Fifteen real-plugin hosted cases passed: allow plan plus saved apply, mandatory deny, approved override, legacy-agent rejection, invalid Setup, missing plugin, unresolved required results, plan RPC crash/cancellation, apply RPC crash/cancellation, altered saved-plan bytes, a changed policy snapshot before apply, abrupt worker death with a stopped plugin, and hard cancellation of a stopped plugin. The crash, graceful-cancel and hard-cancel cases persisted all 200 actual local resources and left the run errored with a no-rollback warning. The worker-death case first failed because the owner survived its parent; it now stops the owner and startup reconciliation captures all 200 resources for recovery. The allow/deny cases also rejected a changed snapshot and a forged passed check against a signed denial. State versions and native policy checks were persisted, including actual matched provider and nested-module results in the allow case. Tests use only built-in `terraform_data`, isolated local databases/state, a private loopback TLS endpoint and an owned bounded cgroup. Host settings remained unchanged and the test subtree was empty and removed.

All harness modes require an already prepared non-root, zero-capability process and its own delegated cgroup. Supply `--owner`, `--profile` (the owner test profile with `runtime`), `--plugin`, `--plugin-sha256`, `--output` (a new private directory), `--repository` and `--cgroup-root`. They do not prepare host privileges or download the plugin. `--cases` selects a comma-separated subset of the standalone owner or hosted cases.

The init admission regression is also covered at both production install hooks and the owner verifier: a known unapproved mandatory or mandatory-overridable denial blocks init even with a required unknown sibling. Pure unknowns remain deferrable at init; required unknowns are rejected during plan/apply regardless of a sibling's soft denial. The focused tests failed against the preceding implementation and pass after the fix. The original-protocol strict-owner matrix now includes the same mixed-init cases and a pure-unknown control. CI builds this patched reference engine and requires a non-skipped `TestNativeOwner` run with pinned fixture/runtime artifacts and zero capabilities. The stock-engine transport matrix remains a separate layer.

The real API/agent harness passed six cases with the unmodified operator plugin: allow plus saved apply and a zero-addition follow-up plan, mandatory deny, authorized override plus saved apply, plugin SIGKILL during a post-apply resource RPC, owner cancellation during a post-apply resource RPC, and abrupt agent death/restart during a stopped post-apply RPC. Both failures persisted all 200 actual local resources and left the run errored. The agent-death case retained the journaled execution directory, kept the server workspace locked after lease loss, and accepted the original fenced recovery completion before unlocking. The full run rejected 45 tampered artifacts and 24 unauthorized/stale manifest requests. The initial agent run exposed callback socket path limits and state capture overwriting the backend file; short separate engine scratch and protected state capture fix both. The strict-owner allow case now uses a long workspace path. Backend regressions cover proof binding, missing receipts, forged counts, and state recovery after lease loss/cancel. The agent has 96 passing Rust tests and clean format/check/Clippy results. Forty-five focused backend recovery/cgroup/API tests pass. The retention and nested-cgroup regressions failed before their fixes and now pass: terminal/deleted native artifacts expire with saved plans, live plans and unpromoted state remain protected, and hard cancellation includes nested native groups.

To reproduce with an independently built matching agent and its helper, use `integration/real-owner.py --agent-binary /absolute/terrence-agent --agent-runner /absolute/agent-landlock-runner --plugin-archive /absolute/operator.zip` with the common owner/profile/plugin/output/repository/cgroup arguments above. This remains an opt-in licensed-plugin test and does not prepare host privileges or alter host settings.

## Release and recovery

Release the matching server and agent, rebuild and repin the owner, then create fresh plans. Runtime/owner changes invalidate older admission. The stock service/container examples do not establish the required delegation or capability restrictions; supply the runtime and read-only profile through the operator's deployment configuration. The proprietary plugin and compiled reference engine are not shipped in either image.

Before enabling a profile, run the owner's offline readiness check as the service identity inside its delegated hierarchy. This uses public runtime metadata and does not launch the policy plugin:

```sh
umask 077
native_probe=$(mktemp)
jq '{schemaVersion:1,runtime:.runtime,cgroupRoot:.cgroupRoot}' "$TERRENCE_TFPOLICY_RUNTIME_PROFILE" > "$native_probe"
native_owner=$(jq -r '.owner.path' "$TERRENCE_TFPOLICY_RUNTIME_PROFILE")
"$native_owner" probe --config "$native_probe"
rm -f "$native_probe"
```

For an agent host, use its `TERRENCE_AGENT_NATIVE_POLICY_PROFILE` in that check and run `terrence-agent probe-sandbox` for its separate state-capture helper. Registration repeats both readiness checks before advertising native execution.

A hosted worker interrupted during apply is not replayed. Startup reconciliation retains the actual state in the existing encrypted run recovery copy. Inspect and recover it through the run's Recover action or recovery-state API before starting another apply.

An interrupted native agent apply keeps its workspace lock and local execution directory until state recovery is acknowledged. The durable journal records `work_dir` before native execution. Restart reports an error and preserves that directory; it does not replay the apply. After verifying the old native cgroup is empty, the owning agent can return the retained Terraform state using its original run ID, operation and fencing token in an errored completion. The server persists that state, keeps the run errored and only then releases the lock. The matching agent README describes this completion. Do not delete the journal or retained state to clear the lock.

Native admission artifacts follow `TERRENCE_RECOVERY_RETENTION_MS` for final or deleted runs. Live plans are retained. Explicit discard/delete uses the same paired saved-plan/native-source cleanup. Unpromoted managed-state recovery copies remain protected until an operator recovers them.
