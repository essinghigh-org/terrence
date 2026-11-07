# Native policy execution

The draft for #1056 includes hosted execution and an explicitly negotiated agent path. Both are opt-in through operator-managed runtime profiles. Legacy agents remain blocked. The feature is not ready to merge while the remaining acceptance work below is open.

## Implemented

- Strict Terraform 1.17.1 startup and phase completion, with protected audit and saved-plan pipes closed before provider/plugin execution. A stock engine is rejected.
- A Linux execution owner that pins the engine, runner, supervisor, shim, recorder and operator-supplied plugin; requires Landlock ABI 6, zero capabilities and a finite delegated cgroup; captures bounded evidence and verifies process-tree cleanup.
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

Build `landlock-runner` with the repository's existing recipe. Install the licensed operator plugin separately. Make every executable canonical, regular, non-writable and singly linked. Set up a short, service-owned 0700 private parent outside run workspaces; its absolute path must be at most 25 bytes because native transport uses Unix sockets. Give the worker its own delegated cgroup root, with the necessary controllers already enabled by the operator. No host-global cgroup, core-dump or kernel setting is changed by the owner.

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

The same harness with `--hosted-worker --plugin-archive /absolute/operator.zip` invokes the production worker and persisted policy gates through `backend/tests/compat/tfpolicy-owner/worker.ts`. Four real-plugin hosted cases passed: allow plan plus saved apply, mandatory deny blocking apply, an approved overridable denial plus saved apply, and a legacy agent blocked from claiming a hosted native plan. The allow/deny cases also rejected a changed snapshot and a forged passed check against a signed denial. State versions and native policy checks were persisted, including actual matched provider and nested-module results in the allow case. Tests use only built-in `terraform_data`, isolated local databases/state, a private loopback TLS endpoint and an owned bounded cgroup. Host settings remained unchanged and the test subtree was empty and removed.

Both harness modes require an already prepared non-root, zero-capability process and its own delegated cgroup. Supply `--owner`, `--profile` (the owner test profile with `runtime`), `--plugin`, `--plugin-sha256`, `--output` (a new private directory), `--repository` and `--cgroup-root`. They do not prepare host privileges or download the plugin.

The init admission regression is also covered at both production install hooks and the owner verifier: a known unapproved mandatory or mandatory-overridable denial blocks init even with a required unknown sibling. Pure unknowns remain deferrable at init; required unknowns are rejected during plan/apply regardless of a sibling's soft denial. The focused tests failed against the preceding implementation and pass after the fix. The original-protocol strict-owner matrix now includes the same mixed-init cases and a pure-unknown control. CI builds this patched reference engine and requires a non-skipped `TestNativeOwner` run with pinned fixture/runtime artifacts and zero capabilities. The stock-engine transport matrix remains a separate layer.

The real API/agent harness passed five cases with the unmodified operator plugin: allow plus saved apply and a zero-addition follow-up plan, mandatory deny, authorized override plus saved apply, plugin SIGKILL during a post-apply resource RPC, and owner cancellation during a post-apply resource RPC. Both failures persisted all 200 actual local resources and left the run errored. The same run rejected 40 tampered artifacts and 20 unauthorized/stale manifest requests. The initial agent run exposed callback socket path limits and state capture overwriting the backend file; short separate engine scratch and protected state capture fix both. The strict-owner allow case now uses a long workspace path. Backend regressions cover proof binding, missing receipts, forged counts, and state recovery after lease loss/cancel. These are local acceptance results, not deployment qualification.

To reproduce with an independently built matching agent and its helper, use `integration/real-owner.py --agent-binary /absolute/terrence-agent --agent-runner /absolute/agent-landlock-runner --plugin-archive /absolute/operator.zip` with the common owner/profile/plugin/output/repository/cgroup arguments above. This remains an opt-in licensed-plugin test and does not prepare host privileges or alter host settings.

## Remaining before merging #1056

1. Final CI/review and coordinated server/agent release. The matching client is required; older agents remain blocked. Rebuild and repin the owner for the new plan-JSON and stage receipt fields, then create fresh plans.
2. Hosted-worker failure qualification for real-plugin Setup/RPC failure, cancellation, stale or altered artifacts and partial post-apply state. Current real-plugin failures exercise the owner; hosted qualification currently covers allow, deny and override. The fixture's post-apply tests cover the owner, not the entire hosted state publication path.
3. Recovery/retention qualification across worker death, discarded/deleted runs, HA lease loss and all saved-plan lifecycle cleanup paths. Native artifacts are removed when the existing saved-plan cleanup runs; broader lifecycle qualification remains open.
4. Deployment packaging/readiness diagnostics and full CI/review for the final integration. Do not merge or close #1056 based only on local acceptance.
