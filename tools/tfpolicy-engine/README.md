# Native policy engine contract

This source build adds `-strict-policy` to pinned Terraform 1.17.1. It is a prerequisite for native policy execution, not an activation switch for Terrence. Hosted and agent guards remain enabled until their execution owner verifies the complete contract.

See [HANDOFF.md](HANDOFF.md) for verified results and the remaining integration work.

Run `GOTOOLCHAIN=go1.26.10 build.sh /absolute/terraform/git /absolute/new-output-directory` on Linux. The script archives official commit `ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9`, applies the local patch, verifies Go dependencies, runs policy regressions, and builds a static executable. It records the source commit, patch and executable SHA-256, compiler, architecture, and build information. It includes Terraform's BUSL-1.1 license. Original and modified Terraform remain subject to that license; this recipe grants no additional rights. No proprietary tfpolicy-plugin is downloaded or bundled.

`terraform native-policy-contract` reports contract version and source-patch identity. Owners must verify the executable digest as well; a self-reported capability does not authenticate an executable. Stock Terraform rejects `-strict-policy` before execution, so it cannot silently substitute for this build.

Strict execution requires a write-only pipe at descriptor 3, `TF_POLICY_AUDIT_FD=3`, and a fresh 32-byte hexadecimal `TF_POLICY_AUDIT_NONCE`. The descriptor is marked close-on-exec before any policy or provider process starts. Bounded NDJSON records identify Setup, graph inventories, individual targets and exact deterministic Policy RPC request hashes, phase completion, and command outcome. This stream is separate from stdout and the recorder's observed-RPC journal. Missing, duplicate, unbound, or out-of-snapshot results fail execution. The run owner must additionally match resource coverage to the immutable saved plan and authenticate run, workspace, policy snapshot, runtime, cancellation and process-cleanup identities.

Known denials and runtime failures block direct apply before mutations. An explicit plan can retain a denied plan for the owner's policy-override decision while returning failure. Only `mandatory_overridable` policies can consume an explicit owner-provided `TF_POLICY_AUDIT_OVERRIDES` list of `{file,address}` objects. Runtime errors cannot be overridden. Unknown initialization inputs remain deferred to plan; unresolved mandatory plan/apply results block admission. Apply-time failures retain actual state.

Targeted native plans (`-target`) are unsupported and rejected before owner runtime preparation. Terraform marks targeted plans incomplete, while native admission requires a complete saved plan. Create a full plan instead. Other supported planning options, including `-replace`, `-refresh-only` and `-destroy`, remain available.
