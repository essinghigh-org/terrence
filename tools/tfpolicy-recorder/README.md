# Native Terraform policy recorder adapter

This is a transport recorder, not a policy engine or Terraform fork. It forwards the pinned native `Policy` and `CallbackService` protobuf messages without interpreting HCL, provider schemas, plans, or graph behavior. It does not enable execution or remove an apply gate.

## Build and provenance

Run `build.sh /path/to/official/terraform/git /absolute/output/tfpolicy-recorder` with Go 1.26.10. The script reads committed source blobs from official HashiCorp Terraform commit `ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9` (Terraform 1.17.1), never mutable checkout files. Only generated `internal/policy/proto/*.pb.go` transport definitions and their `.proto` sources enter a temporary module. Terraform's engine, CLI, diagnostic conversion helpers and tests are not included or built. The module path preserves Go's `internal` import boundary; the only built executable is this adapter. The official Terraform executable remains separately distributed, unmodified, and checksum-pinned.

The build pins go-plugin 1.7.0, gRPC 1.83.2 and protobuf 1.36.11, verifies module checksums using Go, and prints the adapter's SHA-256. The executable is a static Linux build. Alongside it the script writes the exact resolved go.mod/go.sum, upstream LICENSE and a provenance record containing the upstream commit, Go toolchain and embedded module build information. Its source of truth is this directory plus the recorded upstream commit. The script does not download a proprietary tfpolicy-plugin. An operator supplies that separately, with its executable digest bound in trusted configuration.

Upstream generated protocol sources carry IBM copyright and SPDX `BUSL-1.1`; see the official [LICENSE at the pinned commit](https://github.com/hashicorp/terraform/blob/ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9/LICENSE). Building this adapter does not grant permission to redistribute those definitions or a linked executable outside the applicable license. Preserve copyright notices and the upstream license with any authorized distribution. This transport separation is a technical boundary, not a licensing exemption. Repository licensing also applies to the adapter's original code.

## Supervisor contract

Invoke exactly `tfpolicy-recorder rpcapi`. The trusted supervisor supplies:

- FD 3: private write-only pipe, `TFPOLICY_JOURNAL_FD=3`.
- FD 5: private read-only JSON configuration, `TFPOLICY_RECORDER_CONFIG=/proc/self/fd/5`.
- `PLUGIN_CLIENT_CERT`: the upstream go-plugin AutoMTLS public client certificate, plus the standard protocol/magic-cookie environment.

No configuration path is opened from an environment value. Descriptor numbers are fixed. All inherited private descriptors become close-on-exec before downstream startup. No MAC key is read by this adapter.

Configuration has exactly these fields:

```
{
  "schemaVersion": 1,
  "pluginPath": "/trusted/runtime/tfpolicy-plugin",
  "pluginSha256": "<SHA-256 of executable, not archive>",
  "landlockRunnerPath": "/trusted/runtime/landlock-runner",
  "landlockRunnerSha256": "<SHA-256 of executable>",
  "policyReadRoots": ["/trusted/snapshot/policies"],
  "temporaryDirectory": "/short/private/path",
  "socketDirectory": "/short/private/sockets"
}
```

Executable paths must be canonical regular immutable executable files. Policy roots must be canonical immutable directory trees without symlinks, hard links, or special files. The temporary parent must already be mode 0700; a fresh private child is created and removed by the recorder. The socket directory must be precreated mode 0700 by the supervisor before entering the engine sandbox. Grant the engine `--connect-unix` to that directory, and no write access. The recorder sets its own `TMPDIR` from this trusted field. Keep both paths short enough for Unix sockets. Native Setup must present the exact ordered policy roots in the configuration.

The BYOB plugin always runs through the pinned Landlock runner, requiring ABI 6 or newer and the runner's `--deny-debug` tracing filter. `--connect-unix` is granted only to the private downstream plugin/callback socket directory. Its filesystem allowance contains only its private temporary directory, the pinned plugin executable, immutable policy roots, fixed system library paths, DNS/CA configuration and specific basic device files. No workspace root, supervisor directory, `/proc`, journal, configuration FD or host credentials are exposed. Network access remains available for the operator's plugin entitlement flow; this is not a network egress policy. The plugin gets a fresh downstream AutoMTLS connection, separate from the upstream Terraform/recorder connection.

Normal descendants retain the supervisor process group and parent-death signal. A trusted supervisor must additionally enforce its process-tree/cgroup cleanup policy: process groups alone cannot contain intentionally daemonized descendants. Landlock restrictions remain inherited by descendants. No sandbox opt-out exists in this adapter.

## Journal and completion

FD 3 receives bounded NDJSON records matching `backend/src/lib/tfpolicy-native-evidence.ts`: `sequence`, `id`, `method`, `phase`, `requestSha256`, `result`, `error`. A synchronized begin record is written before each blocking RPC, followed by its matched end. Limits are 100,000 records and 16 MiB. A write/encoding/limit failure poisons the journal and terminates the adapter; it cannot become an allow result.

Deterministic request hashes include evaluation/callback correlation IDs. Setup entitlement credentials are removed before hashing. No raw requests, diagnostics or error text are persisted. Aggregate deny/unknown, contradictory allow plus diagnostics, invalid detail/enforcement results, callback errors, partial/deferred results and unmatched callback correlations produce an error record. Responses remain native protobuf messages, including denials, so normal native rendering still works.

A disconnect triggers explicit broker/client cleanup because go-plugin may use `os.Exit`. There is no adapter-generated completion or admission token. EOF, exit code or a final ALLOW alone does not prove a stage completed. The out-of-sandbox supervisor must bind complete native stdout, journal sequence/correlation completeness, process/cancellation/timeout outcome, run nonce, stage, immutable snapshot, runtime and saved-plan identities, then authenticate its receipt. Existing guards stay enabled until that full owner path is validated.

Package tests cover real in-memory gRPC serialization/callback round trips, begin-before-block ordering, error/deny/unknown handling, private environment/descriptor construction and invalid configuration. The [native qualification matrix](../tfpolicy-supervisor/integration/README.md) supplies live stock-engine and Landlock confinement CI coverage using the original test fixture. Real-plugin acceptance and production admission remain unqualified.
