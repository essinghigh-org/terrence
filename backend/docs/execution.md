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

### Agent lifecycle

- The agent polls for jobs and claims one at a time.
- The agent heartbeats while working.
- A job without a heartbeat past `AGENT_HEARTBEAT_TIMEOUT_MS` is recovered: the job returns to the queue and the run returns to `plan_queued` or `apply_queued`.
- An apply interrupted by an agent loss is never replayed automatically.

### Agent liveness

Agents report their last ping. The agent list shows idle, busy, and unreachable agents. Missing agents block runs until the heartbeat timeout passes.

## The run sandbox

Server-side execution uses Landlock isolation when the kernel supports it (Linux 5.13+, `CONFIG_SECURITY_LANDLOCK`):

- The run process sees only its working directory and the binary directory.
- Provider plugins and provisioners inherit the restrictions.
- The database, encryption keys, and other workspaces are invisible.

The sandbox is enabled by default. If Landlock is unavailable, runs fail with a clear error. Set `TERRENCE_RUN_SANDBOX=false` to disable the requirement explicitly.

Sandboxed runs deny loopback TCP connects by default: TCP to 127/8, ::1 and ::ffff:127/8 fails with EACCES, so IaC code cannot reach host-local services (databases, metadata endpoints, the Terrence API itself) via localhost. Public traffic, RFC1918, UDP (including DNS stubs on loopback) and Unix sockets keep working. Set `TERRENCE_RUN_LOOPBACK_POLICY=allow` only where runs legitimately need localhost (development without `PUBLIC_URL`, where the registry address falls back to localhost); any other value remains denied, and spawns fail with a clear error when the runner binary lacks seccomp user-notify support.

Full TCP isolation stays opt-in: set `TERRENCE_RUN_NET_POLICY=deny` to deny all TCP bind and connect (requires Landlock ABI 4 or newer; a host below ABI 4 cannot execute sandboxed runs under `deny`). The default `allow` keeps provider and provisioner network access working, which trusted configurations require.

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

- The queue poll claims at most 5 runs per cycle.
- One executing run per workspace.
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
