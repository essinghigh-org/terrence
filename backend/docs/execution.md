---
title: Execution
category: Execution
order: 10
description: Execution modes, agent pools, the run sandbox, and binary management.
---

# Execution

Runs execute on the server or on registered agents. The execution environment is isolated and auditable.

## Execution modes

| Mode | Where runs execute |
|---|---|
| Remote | The Terrence worker inside the sandbox. |
| Agent | A registered agent from an agent pool. |
| Local | The CLI executes the apply locally. |

The mode is a workspace setting.

## Remote execution

The worker claims pending runs and executes them with Terraform or OpenTofu. Execution happens in a fresh directory per run, under the run's configuration archive.

Remote runs cannot reach the server's storage or other workspaces. The sandbox enforces this. See the sandbox section below.

### Remote CLI command semantics

Remote execution through the Terraform or OpenTofu CLI (`cloud` or `remote` backend blocks) maps commands to Terrence run operations:

| Command | Supported | Notes |
|---|---|---|
| `terraform init` | Yes | Service discovery (`/.well-known/terraform.json`) and backend state initialization. |
| `terraform plan` | Yes | Creates a remote speculative plan (or queueable run) with detailed exit codes. |
| `terraform apply` | Yes | Executes plan, streams logs, and prompts interactively for apply approval. |
| `terraform apply <plan-file>` | No (CLI constraint) | Upstream remote backends do not support applying saved local binary plans remotely. Apply directly through the CLI or approve via UI/API. |
| `terraform plan -refresh-only` | Yes | Executes a remote refresh-only plan. |
| `terraform destroy` | Yes | Schedules a remote destroy run within the workspace. |

## Local execution

In local mode, the CLI executes the apply on the user's machine. The server provides state and registry access. The sandbox does not apply to the CLI's machine.

## Agents

Agent pools connect external machines to Terrence:

1. Register an agent pool in the organization.
2. Install the agent on a machine.
3. The agent connects to the API and heartbeats.
4. The worker dispatches runs to the pool.

Agent-mode workspaces reference an agent pool. Pool scoping restricts which projects and workspaces a pool can serve.

### Agent capabilities

An agent declares which IaC binaries it can execute at registration (`iac-binaries`: `tofu`, `terraform`, or both). Agents that omit the attribute default to `["terraform"]`, which matches `tfc-agent`. The server resolves each run's binary from the workspace (`iac-binary`, unset means `terraform` for agent execution) and only offers a job to agents that declared the matching binary. A workspace set to `tofu` waits for an agent that declared `tofu`; a plain `tfc-agent` can never claim it.

### Agent protocol compatibility

The agent protocol is a separately versioned product. The agent software
version (`Tfc-Agent-Version`) describes the binary; `Tfc-Agent-Protocol-Version`
describes the wire contract. The discovery endpoint is
`GET /api/agent/protocol`, and registration negotiates the same contract with
`Tfc-Agent-Protocol-Version`, `Tfc-Agent-Capabilities`, and
`Tfc-Agent-Required-Capabilities` (the registration body accepts the matching
`protocol_version`, `capabilities`, and `required_capabilities` fields).

The current protocol version is `1`. Unknown optional capabilities are reported
in `unsupported_capabilities` and ignored, so a newer agent can reconnect to an
older server. An unknown required capability fails registration with `422`; a
registration that offers only unsupported protocol versions fails with `406`.
Agents that omit protocol metadata use the legacy v1 capability set and remain
compatible with the original agent API.

The server only offers a job when the negotiated capabilities cover its
operation and artifact contract. Plan and apply jobs require explicit
operation, configuration, log, lease-fencing, and heartbeat capabilities;
apply additionally requires cancellation and state publication. Artifact
uploads are written to a temporary private file and atomically published only
while the same fencing token still owns the lease.

The run record captures the claimed agent's software version, negotiated
protocol version, capability set, and effective execution policy. This is the
compatibility evidence for that run generation and remains available after the
agent disconnects.

### Agent lifecycle

- The agent polls for jobs and claims one at a time.
- The agent heartbeats while working.
- A job without a heartbeat past `AGENT_HEARTBEAT_TIMEOUT_MS` is recovered: the job returns to the queue and the run returns to `plan_queued` or `apply_queued`.
- Each claim increments a fencing token. Completion, log, state, and artifact
  publication must present that token, including the final state publication.
  A stale or duplicate completion returns `409` with `code:
  stale-agent-lease`; it does not remove an artifact published by a newer run
  generation.
- An apply interrupted by an agent loss is never replayed automatically. A
  canceled run keeps its workspace lock until the agent acknowledges the
  cancellation or its lease expires, after which the stale-job sweep releases
  the lock.

### Agent liveness

Agents report their last ping. The agent list shows idle, busy, and unreachable agents. Missing agents block runs until the heartbeat timeout passes.

## The run sandbox

Server-side execution uses Landlock isolation when the kernel supports it (Linux 5.13+, `CONFIG_SECURITY_LANDLOCK`):

- The run process sees only its working directory and the binary directory.
- Provider plugins and provisioners inherit the restrictions.
- The database, encryption keys, and other workspaces are invisible.

The sandbox is enabled by default. If Landlock is unavailable, runs fail with a clear error. Set `TERRENCE_RUN_SANDBOX=false` to disable the requirement explicitly.

The sandbox protects remote-mode runs. Local-mode runs execute on the CLI machine and are not sandboxed by the server.

## Binary management

Terrence downloads Terraform and OpenTofu binaries on demand:

- Version lists are fetched and cached (`TERRENCE_VERSION_CACHE_TTL_MS`, default 24 hours).
- Binaries are checksum-verified before first use.
- The binary cache lives in `TERRENCE_BINARY_CACHE_DIR` or the storage directory.

A workspace pins its binary version. Unpinned workspaces use the latest available version.

## Run credentials

Each run receives a short-lived token, written to a private CLI configuration file in the run directory. The token is revoked at the end of the run.

See [Tokens](tokens).

## Concurrency

- At most `TERRENCE_RUN_CONCURRENCY` local runs execute at once (default 5). Lower it on small hosts: parallel plans each hold provider processes and state in memory and can OOM. The admin runs tab shows the live limit with executing and queued counts (system-info worker block).
- The queue poll claims at most 5 runs per cycle.
- One executing run per workspace, regardless of the limit.
- Health assessments run under `HEALTH_ASSESSMENT_CONCURRENCY` (default 2).

## Restart safety

A process restart during a run is handled at startup:

- Pre-execution runs return to the queue.
- Interrupted plans and applies move to `errored`.
- Interrupted applies are never re-executed automatically.

See [Runs](runs).

## API surface

- `GET /api/v2/organizations/:org_name/agent-pools`
- `POST /api/v2/organizations/:org_name/agent-pools`
- `POST /api/v2/agent-pools/:id/authentication-token`
- `GET /api/v2/agents`
- `POST /api/v2/agents/:id/actions/stop`
