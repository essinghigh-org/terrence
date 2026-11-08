# Native Terraform policy bootstrap candidate

The transport is now used by the opt-in hosted execution owner in this draft.
See [native execution setup and remaining acceptance work](../tfpolicy-engine/HANDOFF.md).
Current agents remain blocked. Installing these binaries alone does not configure
or qualify native execution.

Stock Terraform executes `$TF_POLICY_PLUGIN rpcapi` and supplies its AutoMTLS
**public** client certificate as `PLUGIN_CLIENT_CERT`. Its private key remains
inside Terraform. No engine key, receipt signing key, journal FD, or recorder
configuration enters the workspace or shim.

## Trust and launcher prerequisites

The trusted launcher must:

1. Start or gate a specific trusted Terraform engine process, recording its host
   PID and `/proc/PID/stat` starttime (field 22), and UID. The supervisor uses a
   trusted host procfs and host PID namespace, never a sandbox-controlled procfs.
2. Put a pinned immutable shim inside the run sandbox, with its executable path
   matching the supervisor's `/proc/PID/exe` view. Set `TF_POLICY_PLUGIN` to this
   shim and `TFPOLICY_SUPERVISOR_SOCKET` to the per-run socket pathname. The latter
   is nonsecret routing only. Redirecting it cannot produce an authorized receipt.
3. Create a supervisor-owned private 0700 run directory outside sandbox writes.
   Config files are supervisor-owned regular 0600 files. Expose only the socket
   endpoint to the sandbox, never its writable parent, recorder config, journal,
   result files, or signing material. The pathname socket has mode 0600; launch
   with a compatible UID/mount arrangement. This implementation does not grant
   cross-UID socket access or modify ACLs.
4. Supply immutable pinned recorder and shim binaries. The supervisor checks the
   actual shim executable inode via procfs and launches the recorder from the
   verified open executable FD, not a later pathname lookup. The trusted recorder
   must sandbox BYOB execution; this supervisor never directly launches BYOB.
5. Explicitly deny `ptrace`, `process_vm_writev`, `process_vm_readv`, and
   `pidfd_getfd`, `kcmp`, `perf_event_open`, and `bpf` (including ABI aliases)
   in the **engine and all untrusted provider/BYOB execution
   domains**, and prevent access to another process's `/proc/PID/mem` and proc
   file descriptors. Apply an appropriate seccomp policy before engine startup,
   with the Landlock runner's mandatory `--deny-debug` option, no-new-privileges,
   and no capability escalation. Keep the engine's private
   client key inaccessible to workspace/provider code. Landlock alone does not
   provide this guarantee; do not rely on Yama defaults. The shim does not set
   dumpable=0 because that would prevent ordinary supervisor procfs inspection. These are mandatory launcher
   prerequisites, not implemented or enabled by this transport.
6. Own a per-run cgroup and reap it on any failure, cancellation, supervisor
   death, or completion. Process-group SIGKILL and recorder Pdeathsig provide
   cleanup here but cannot contain descendants that deliberately create a new
   session. Set trusted outer CPU, memory, process, and output limits.
7. Correlate the recorder journal with engine lifetime, exit, exact stdout hash,
   immutable snapshot, and the signed final receipt outside the sandbox. A
   successful bootstrap or recorder process exit is never a completed policy run.

Private configuration (all fields required; illustrative values):

```json
{
  "socket_path": "/private/run-123/bootstrap.sock",
  "engine_pid": 4321,
  "engine_start_time": 987654,
  "peer_uid": 1000,
  "shim_path": "/trusted/tfpolicy-shim",
  "shim_sha256": "<64 lowercase hex characters>",
  "recorder_path": "/trusted/tfpolicy-recorder",
  "recorder_sha256": "<64 lowercase hex characters>",
  "recorder_config_path": "/private/run-123/recorder.json",
  "journal_path": "/private/run-123/journal.jsonl",
  "run_nonce": "<64 lowercase hex characters>",
  "startup_seconds": 10,
  "lifetime_seconds": 3600,
  "max_journal_bytes": 16777216
}
```

The recorder's private JSON schema belongs to `../tfpolicy-recorder`. It must
identify pinned BYOB and sandbox-runner executables, immutable policy read roots,
and a separate private writable temporary parent. It is never supplied by the
shim. `TFPOLICY_RUN_NONCE` is trusted correlation data, not a signing secret.

Run `tfpolicy-supervisor serve --config /private/run-123/supervisor.json` before
allowing Terraform to exec the shim. No shell, command argument, environment
extension, recorder path, journal path, or policy path is accepted from clients.
Socket paths must not exist: stale paths fail rather than being unlinked.

## Wire and recorder contract

One bounded JSON line is accepted from the authenticated shim, containing only
`client_certificate`, `protocol_versions`, and the fixed policy `cookie`.
SO_PEERCRED supplies UID/PID. The peer must be an actual direct child of the
configured engine PID, with matching engine starttime, pinned executable path and
SHA256, and exactly the `rpcapi` argument. Identity is rechecked before launch and
monitored while running. Other connections/attempts fail the run closed; there
is no retry or multi-client service. UID checks alone are not authorization.

The recorder is invoked exactly as `recorder rpcapi` using a clean environment:

- `PLUGIN_CLIENT_CERT`: validated single public PEM certificate.
- `PLUGIN_PROTOCOL_VERSIONS`: bounded numeric version list.
- `TF_POLICY_PLUGIN=6F11ED78A2AB` (go-plugin cookie, not an executable path here).
- `TFPOLICY_RUN_NONCE`: configured correlation nonce.
- `TFPOLICY_JOURNAL_FD=3`: write-only pipe to the exclusive 0600 journal sink.
- `TFPOLICY_RECORDER_CONFIG=/proc/self/fd/5`: opened private read-only config.

FD4 is the pinned recorder executable. The recorder must not inherit FD3/4/5 or
these environment variables into untrusted BYOB. Only FD3 bytes become journal
bytes, with an explicit configured cap of at most 64 MiB. Shim input and recorder
stdout/stderr can never become journal records. Recorder stderr is discarded to
avoid diagnostic data leakage in this prototype.

The first recorder stdout line must be a bounded protocol-1 gRPC handshake with
an actual public server certificate. It is forwarded **unchanged** to Terraform
through the shim. Terraform then connects directly to the recorder using mTLS;
the shim is not an RPC proxy. The trusted recorder is responsible for binding an
endpoint reachable from the engine sandbox. Extra stdout fails closed.

The shim remains connected for lifetime cancellation. New shim data, unexpected
identity changes, malformed handshake, journal overflow, or timeout fails closed
and kills the recorder process group. After the authenticated handshake only,
shim EOF or confirmed process disappearance/reparenting can produce the explicit
`engine_shutdown_observed` disposition: the recorder is intentionally killed,
its wait status must be zero or the requested SIGKILL, and both journal and stdout
must drain cleanly within one second. An already observed recorder failure,
extra output, interrupted drain, or timeout cannot become this disposition.
This accommodates stock go-plugin killing its shim during ordinary teardown.
It does not imply a successful engine exit or a complete policy journal. SIGINT/SIGTERM cancellation and parent death are handled.
The output `journal.jsonl.status.json` is deliberately always `completed:false`.
`transport:recorder_exited_cleanly` means only process/pipe closure succeeded;
`transport:engine_shutdown_observed` means only the bounded intentional teardown
above succeeded. The parent must still require actual engine exit zero, complete
native capture, strict complete matched RPC journal, and an empty owned cgroup;
`transport:failed`, a missing status, or a partial journal is never success.
No status file is signed and no status file is an admission receipt.

## Build and tests

Requires Go 1.23+; standard library only:

```sh
go build ./cmd/tfpolicy-shim ./cmd/tfpolicy-supervisor
go test -race -count=1 -v ./...
go vet ./...
```

Pure tests cover cert/private-key rejection, bounded framing, malformed process
stat data, mandatory mTLS handshakes, private config permissions, and rejected
peer identities. Native socket tests cover SO_PEERCRED, socket permissions,
single-use path behavior, unchanged handshake relay, journal-only collection,
extra stdout rejection, and shim-death cancellation. Only a kernel denial of AF_UNIX skips socket tests; other errors fail. Live
AF_UNIX tests passed during independent review, alongside the full race suite
and vet. Non-Linux builds explicitly reject bootstrap operation.

## Native integration qualification

See [integration/README.md](integration/README.md) for the gated stock Terraform
matrix and prerequisite-only GitHub workflow. A missing facility is reported as
not run, never a live qualification pass.
