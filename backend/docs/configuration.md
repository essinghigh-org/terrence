---
title: Configuration
category: Reference
order: 10
description: Every environment variable, its default, and its purpose.
---

# Configuration

Terrence runs with no environment variables set. Development defaults apply. The variables below enable specific features.

Set variables through the container environment or an `.env` file.

## Start here

Minimum viable production config. Everything else below is advanced and can stay unset:

```bash
NODE_ENV=production
PUBLIC_URL=https://terraform.example.com
ADMIN_PASSWORD=<long-random-secret>   # first boot only
ENCRYPTION_PASSWORD=<stable-secret>   # keep forever; losing it loses secrets
STORAGE_DIR=/app/backend/storage      # persisted volume
DATABASE_URL=file:/app/backend/storage/terrence.db
```

Read [Quick start](quickstart) for first boot, [Operations](operations) for backups, and [Upgrading](upgrading) before updating.

## Core

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port. |
| `NODE_ENV` | `development` | Set `production` for production behavior. |
| `PUBLIC_URL` | derived | Public URL of the instance. Used for webhook callbacks, redirects, and registry hostname resolution. |
| `DATABASE_URL` | `file:<storage>/terrence.db` | Database connection. PostgreSQL strings select the PostgreSQL backend. `<storage>` is `STORAGE_DIR`, default `<repo>/backend/storage`. |
| `STORAGE_DIR` | `<repo>/backend/storage` | Directory for archives, state, binaries, and the version cache. `/app/backend/storage` in the container. Must persist. |
| `CORS_ORIGIN` | dev default | Allowed CORS origin for the web interface. |
| `ENCRYPTION_PASSWORD` | generated | Password for encryption-at-rest features. |
| `SIGNED_URL_SECRET` | generated | Secret for signed URL tokens (state downloads). |
| `SIGNED_URL_TTL_SECONDS` | `300` | Lifetime of signed download URLs. |
| `LOG_LEVEL` | `info` | Log verbosity. Site Admin logging settings can override it at runtime. |
| `BUILD_SHA` / `BUILD_VERSION` | none | Build identifiers shown in diagnostics. |

## Administration and users

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | none | Bootstraps the first administrator. Minimum 10 characters. Runs once. |
| `ADMIN_USERNAME` | `admin` | Username of the bootstrapped administrator. |
| `ADMIN_EMAIL` | none | Email of the bootstrapped administrator. |
| `ADMIN_ORGANIZATION` | `default` | Organization created for the administrator at bootstrap. |
| `TERRENCE_ADMIN_PASSWORD_RESET` | off | One-shot solo-admin recovery: with `ADMIN_PASSWORD` set, reset the named site-admin account at boot and force a password change at next login. One-shot per distinct password (a consumed marker in storage blocks replays); remove both variables after recovery. Anything else leaves the instance untouched. |
| `TERRENCE_ENABLE_LOCAL_SIGNUP` | off | Default for local registration. Override in Site administration → Authentication → Local registration without restarting. Registrations never become site admins. |
| `TERRENCE_PASSWORD_MIN_LENGTH` | policy | Minimum password length. |
| `CLI_TOKEN_TTL_MS` | default | Lifetime of CLI-issued tokens. |
| `IACT_TOKEN` | none | Installer access token accepted during bootstrap. |
| `IACT_QUERY_TOKEN_ENABLED` | off | When `1`, accept the `?token=` query form for the reference installer. Default is the header-only flow (`X-IACT-Token` or `Authorization: Bearer`), which keeps the secret out of proxy logs and browser history. |

## Worker and scheduler

| Variable | Default | Purpose |
|---|---|---|
| `TERRENCE_DISABLE_WORKER` | off | When `1`, run without the worker. Pending runs stay queued. |
| `TERRENCE_WORKER_POLL_MS` | `1500` | Run queue poll interval. Values below 100 ms fall back to the default. |
| `TERRENCE_AUTO_DESTROY_POLL_MS` | `30000` | Auto-destroy scan interval. Minimum 5000 ms. |
| `TERRENCE_ASSESSMENT_POLL_MS` | `60000` | Assessment discovery interval. Minimum 5000 ms. |
| `TERRENCE_DRAIN_GRACE_MS` | `6000` | Shutdown drain wait for in-flight executions. Maximum 25000. |
| `HEALTH_ASSESSMENT_CONCURRENCY` | `2` | Parallel health assessments. |
| `HEALTH_ASSESSMENT_INTERVAL_MS` | default | Minimum interval between assessments of one workspace. |
| `AGENT_HEARTBEAT_TIMEOUT_MS` | default | Agent heartbeat timeout before jobs are recovered. |
| `RUN_TASK_TIMEOUT_MS` | default | Run task request timeout. |
| `TERRENCE_ALLOW_INSECURE_RUN_TASK_URLS` | off | Allow HTTP pre-apply and enabled global task endpoints. Use only for trusted development; HTTPS is required by default. |
| `GC_GRACE_PERIOD_DAYS` | default | Grace period for soft-deleted runs before garbage collection. |
| `TERRENCE_RUN_CONCURRENCY` | `5` | Parallel local runs. Non-positive or non-integer values fall back to the default. |
| `TERRENCE_RECOVERY_RETENTION_MS` | `604800000` (7 days) | Retention for saved plans. Interrupted-apply recovery copies are kept until recovered (consumed) and never time-pruned. |
| `MIGRATION_SKIP_DRAIN` | off | Migration wizard skips waiting for active runs to drain. |
| `TERRENCE_DISABLE_RESTART` | off | Test/benchmark mode: the migration wizard suppresses the post-migration restart. Restart the process manually to boot on PostgreSQL. |

## Run execution

| Variable | Default | Purpose |
|---|---|---|
| `TERRENCE_RUN_SANDBOX` | enabled | Run sandbox mode. Enabled by default. `false` disables the Landlock requirement. |
| `TERRENCE_LANDLOCK_RUNNER` | bundled | Path to the landlock runner binary. |
| `TERRENCE_SANDBOX_EXTRA_RW_PATHS` | none | Extra read-write paths for the sandbox. |
| `TERRENCE_SANDBOX_EXTRA_RW_ALLOWED` | off | Allow the extra paths to be specified. |
| `TERRENCE_BINARY_CACHE_DIR` | storage | Directory for downloaded Terraform and OpenTofu binaries. |
| `TERRENCE_VERSION_CACHE_TTL_MS` | `86400000` | Lifetime of cached version lists. `0` never reuses. |
| `TERRENCE_VERSION_CACHE_FILE` | storage | Path of the version cache file. |
| `TERRENCE_ALLOW_PRIVATE_URLS` | off | Allow outbound requests to private network addresses. |
| `ALLOW_UNVERIFIED_CHECKSUMS` | off | Skip binary checksum verification. For restricted networks only. |
| `ALLOW_TOOL_FALLBACK` | off | Allow fallback binary sources when the primary mirror is unreachable. |
| `TERRENCE_RUN_NET_POLICY` | `allow` | Run network policy. `deny` isolates untrusted provider code from the instance network (needs Landlock ABI >= 4). |
| `TERRENCE_EXECUTOR_BACKEND` | `landlock` | Executor backend: `landlock`, `container`, `kubernetes`, `agent`, or `microvm`. Unknown values fall back to `landlock`. |
| `TERRENCE_SANDBOX_MIN_ABI` | runner minimum | Minimum Landlock ABI the readiness gate requires. Unset means no floor beyond the sandbox-required check; invalid values are ignored. |
| `TERRENCE_AGENT_UPDATE_URL` / `TERRENCE_AGENT_UPDATE_SHA256` / `TERRENCE_AGENT_UPDATE_VERSION` | none | Agent binary self-update source: URL plus expected SHA256 plus version pin. |
| `TERRAFORM_CONFIG_INSPECT_PATH` | bundled | Path to the config inspector binary. |
| `TERRAFORM_TEST_BINARY_PATH` | none | Path for the module test binary. |
| `SENTINEL_BINARY_PATH` | none | Path to the Sentinel policy engine binary (bring-your-own; Sentinel is proprietary with no public download, so there is no managed install). |
| `OPA_BINARY_PATH` | none | Explicit path to the OPA policy engine binary, used as-is instead of the managed install. An override that resolves to nothing reports checks unreachable; it never triggers a download. |
| `OPA_VERSION` | `1.20.2` | OPA version to manage on demand into `<STORAGE_DIR>/binaries/opa/<version>/` (digest-verified) when a workspace with OPA policies runs and no override or PATH binary resolves. |
| `GPG_BINARY_PATH` | system | Path to the GPG binary for provider signing keys. |
| `TERRENCE_STACK_IAC_BINARY` | `terraform` | IaC binary for stack runs. |
| `TERRENCE_STACK_IAC_VERSION` | `latest` | IaC binary version for stack runs. |
| `TERRENCE_SANDBOX_EXTRA_RW_ALLOW_STORAGE` | off | Allow extra sandbox read-write paths under the storage directory. |
| `TERRENCE_BINARY_PROBE_TIMEOUT_MS` | `10000` | Timeout for probing an IaC binary version. |
| `TERRENCE_BINARY_DOWNLOAD_TIMEOUT_MS` | `120000` | Per-attempt timeout for IaC binary archive downloads (60-100 MiB archives need headroom on slow links). |
| `TERRENCE_BINARY_DOWNLOAD_RETRIES` | `2` | Retries for timed-out, failed-connection, or transient (429/5xx) binary downloads. Retry count defaults to 2 (capped at 5); backoff doubles from 1s, capped at 10s. Unpublished versions (404) and rejected archives fail fast. |
| `TERRENCE_AGENT_FORWARD_TIMEOUT_MS` | `60000` | Agent forward deadline. Clamped to 1s..300s. |
| `TERRENCE_COMPATIBILITY_VERSION` | `2.5.0` | Advertised TFE compatibility version. Keep dotted: the tfe provider feature gates fail on release-style strings. |
| `TERRENCE_TFE_COMPATIBILITY_VERSION` | alias | Older alias for the same setting; `TERRENCE_COMPATIBILITY_VERSION` wins when both are set. |
| `TERRENCE_TFP_API_VERSION` | `2.6` | Advertised Terraform provider API version, kept separate so a release-style compat string cannot break version negotiation. |
| `GITHUB_TOKEN` / `GH_TOKEN` | none | Token for OpenTofu/Terraform release enumeration. Behind shared IPs the unauthenticated rate budget burns through deep paging; setting either token raises the ceiling and fixes stalled binary downloads. |

## VCS integration

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_APP_ID` | none | GitHub App ID. |
| `GITHUB_APP_SLUG` | none | GitHub App slug. |
| `GITHUB_APP_PRIVATE_KEY` | none | GitHub App RSA private key. |
| `GITHUB_WEBHOOK_SECRET` | none | Webhook secret from the GitHub App settings. |
| `GITHUB_APP_HTTP_URL` | `https://github.com` | GitHub HTTP URL for GitHub Enterprise. |
| `GITHUB_APP_API_URL` | `https://api.github.com` | GitHub App API URL for GitHub Enterprise. GitHub App calls require HTTPS. |
| `GITHUB_API_URL` | derived | API URL used for VCS lookups. GitHub App calls require HTTPS. |
| `TERRENCE_ALLOW_INSECURE_OAUTH_URLS` | false | Development-only opt-in for HTTP OAuth endpoint URLs; development requires this flag, while tests allow HTTP automatically. Ignored outside development. Never enable in production. |
| `TERRENCE_ALLOW_PRIVATE_VCS_URLS` | off | Allow configured VCS URLs to target private-network addresses. Off by default; enabling it permits private-network VCS requests and increases the risk of server-side request forgery. Use only in trusted environments. |
| `GITLAB_WEBHOOK_SECRET` | none | Secret for GitLab webhook deliveries. |
| `BITBUCKET_WEBHOOK_SECRET` | none | Secret for Bitbucket webhook deliveries. |

## Cost estimation

| Variable | Default | Purpose |
|---|---|---|
| `INFRACOST_ENABLED` | off | Enable cost estimation. |
| `INFRACOST_VERSION` | `0.10.45` | Infracost version to manage. |
| `INFRACOST_BINARY` | none | Absolute path override for the Infracost executable. |
| `INFRACOST_API_KEY` | none | Infracost API key for price lookups. |

## Audit and diagnostics

| Variable | Default | Purpose |
|---|---|---|
| `AUDIT_STRICT` | off | Record token minting, SSH key access, and sensitive variable reads. |
| `TERRENCE_SYSLOG_TARGET` / `TERRENCE_SYSLOG_TARGETS` | none | Remote syslog destination(s). Site Admin logging settings override these when persisted. |
| `TERRENCE_SYSLOG_LEVEL` | `LOG_LEVEL` | Remote syslog verbosity. |
| `TERRENCE_SYSLOG_HOSTNAME` / `TERRENCE_SYSLOG_APP` | derived / `terrence` | Remote syslog identity overrides. |
| `TERRENCE_SYSLOG_FORMAT` | `rfc5424` | Syslog message shape: `rfc5424` structured data or bare `json` object per message (one per UDP datagram, newline-delimited over TCP). |
| `TERRENCE_QUERY_LOG` | off | Log every database query. |
| `TERRENCE_QUERY_COUNT` | off | Count database queries for diagnostics. |
| `MIGRATION_CHECKPOINT_RETRIES` | default | Retry count for migration checkpoints. |
| `MIGRATION_DRAIN_TIMEOUT_MS` | default | Drain timeout for the migration wizard. |
| `TERRENCE_DB_SLOW_QUERY_MS` | `1000` | Threshold for slow database query logging. |

## Operations and clustering

| Variable | Default | Purpose |
|---|---|---|
| `TERRENCE_NODE_ID` | `terrence-node-1` | Node identity reported in readiness responses. |
| `TERRENCE_NODE_ADDRESS` | none | Node address reported in readiness responses. |
| `TERRENCE_NODE_STATUS` | active | Override the readiness status. `draining` or `maintenance` marks the node as draining. |
| `TERRENCE_TOKEN_HASH_SECRET` | generated | Stable secret for token hashing. Single-node installs persist a 256-bit secret in storage; multi-replica deployments must set the same value on every replica. Must be at least 32 bytes. |

## Outbound access and proxies

| Variable | Default | Purpose |
|---|---|---|
| `TERRENCE_OUTBOUND_ALLOW_HOSTS` | none | Extra hosts permitted to receive outbound VCS, registry, and webhook traffic beyond the built-in private-address blocks. |
| `TERRENCE_OUTBOUND_ALLOW_CIDRS` | none | Extra CIDRs permitted the same outbound traffic. |
| `TERRENCE_TRUSTED_PROXY_CIDRS` | none | Comma-separated CIDRs trusted as proxies: their `X-Forwarded-For` is used for client-IP resolution and their `X-Forwarded-Host`/`X-Forwarded-Proto` for generated links. Forwarded host headers from other peers are ignored. |
| `TERRENCE_CSP_STRICT` | off | When `1`, serve the UI with a strict Content-Security-Policy. |

## Rate limits

Enforced per principal with fixed windows. The live configuration is reported by `GET /api/v2/capabilities`.

| Variable | Default | Purpose |
|---|---|---|
| `RATE_LIMIT_MAX` | `60` per 1s | General bucket: every server endpoint outside the buckets below. |
| `RATE_LIMIT_SENSITIVE_MAX` | `5` per 60s | Login plus sensitive writes. |
| `RATE_LIMIT_SSO_GET_MAX` | `60` per 60s | SSO redirect, callback, and IdP logout (higher bound for shared corporate egress). |
| `RATE_LIMIT_SCIM_SETTINGS_MAX` | `20` per 1s | SCIM admin settings. |
| `RATE_LIMIT_SCIM_MAPPING_MAX` | `10` per 60s | SCIM team-group mapping writes. |
| `RATE_LIMIT_WORKSPACE_RUN_HISTORY_MAX` / `RATE_LIMIT_WORKSPACE_RUN_HISTORY_DURATION_MS` | `120` per 60s | Workspace run-history reads. |

## Database timeouts

Postgres server-side fail-safes (milliseconds). SQLite uses `busy_timeout` and WAL instead.

| Variable | Default | Purpose |
|---|---|---|
| `TERRENCE_DB_STATEMENT_TIMEOUT_MS` | `30000` | Kill stuck queries and recycle the pool connection. |
| `TERRENCE_DB_LOCK_TIMEOUT_MS` | `10000` | Kill contended locks and recycle the pool connection. |
| `TERRENCE_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `60000` | Kill idle transactions and recycle the pool connection. |

## Test simulation

Simulation hooks for the test suite. They bypass real IaC execution and must never be set in production. Listed here so operators recognize them in code and CI; they are not operator configuration.

| Variable | Default | Purpose |
|---|---|
| `SIMULATED_RUNS` | off | Run the worker and stack worker against simulated executions instead of real binaries. |
| `SIMULATED_PLAN_JSON` | `{}` | Injected plan JSON for simulated runs. |
| `SIMULATED_ASSESSMENT_JSON` | empty changes | Injected plan JSON for simulated health assessments. |
| `SIMULATED_ASSESSMENT_SCHEMA` | `{}` | Injected provider schema for simulated health assessments. |
| `SIMULATED_STACK_PLAN_CHANGES` | off | Simulated stack plans report changes. |
| `SIMULATED_STACK_DEFERRED` | off | Simulated stack plans report deferred changes. |

## Operator scripts

Environment for the helper scripts under `backend/scripts` and `frontend/scripts`.

| Variable | Default | Purpose |
|---|---|
| `TFE_TOKEN` | none | Site-admin application token for `tfectl` admin commands and agent run environments. |
| `TFE_ADDRESS` | `http://localhost:3000` | Application API address for `tfectl`. |
| `TFE_SYSTEM_ADDRESS` | derived | System API address for `tfectl`. Defaults to the application host on port 8443. |
| `TFE_SYSTEM_TOKEN` | none | Dedicated System API token for `tfectl`. |
| `TFE_PROVIDER_VERSION` | latest stable | Pinned provider version for `refresh-provider-surface`. |
| `TERRENCE_PROVIDER_SURFACE_FORCE` | off | When `1`, regenerate the provider surface catalog at startup even when schema hashes are unchanged. |
| `TERRAFORM_BIN` | `terraform` | Alternate IaC CLI for `refresh-provider-surface`. |
| `COVERAGE_THRESHOLD` | `60` | Coverage floor for `coverage-report --fail`. |
| `BACKEND_URL` | `http://127.0.0.1:3000` | Backend proxied by the frontend dev server. |

## Dependency update policy

Bun rejects releases younger than three days (`minimumReleaseAge = 259200`).
Renovate uses the matching `minimumReleaseAge` and does not run standalone lock
file maintenance, because that job can ask Bun to resolve a newly published
package and turn the repository's deliberate release-age guard into a failed
Renovate branch. Direct dependency updates still refresh and validate
`bun.lock`; CI checks both the frozen lockfile and this policy. Do not weaken
the three-day guard to clear a Renovate warning.

## Invalid values

Poll interval variables validate their values. Invalid, empty, or sub-minimum values fall back to the documented default. This rule prevents a misconfiguration from hot-looping the database.
