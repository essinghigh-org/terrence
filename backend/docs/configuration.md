---
title: Configuration
category: Reference
order: 10
description: Every environment variable, its default, and its purpose.
---

# Configuration

Terrence runs with no environment variables set. Development defaults apply. The variables below enable specific features.

Set variables through the container environment or an `.env` file.

## Core

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port. |
| `NODE_ENV` | `development` | Set `production` for production behavior. |
| `PUBLIC_URL` | derived | Public URL of the instance. Used for webhook callbacks, redirects, and registry hostname resolution. |
| `DATABASE_URL` | `file:./storage/terrence.db` | Database connection. PostgreSQL strings select the PostgreSQL backend. |
| `STORAGE_DIR` | `./storage` | Directory for archives, state, binaries, and the version cache. Must persist. |
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
| `ADMIN_ORGANIZATION` | none | Organization created for the administrator at bootstrap. |
| `TERRENCE_ENABLE_LOCAL_SIGNUP` | off | Allow registration through the API. Registrations never become site admins. |
| `TERRENCE_PASSWORD_MIN_LENGTH` | policy | Minimum password length. |
| `CLI_TOKEN_TTL_MS` | default | Lifetime of CLI-issued tokens. |
| `IACT_TOKEN` | none | Installer access token accepted during bootstrap. |
| `IACT_QUERY_TOKEN_DISABLED` | off | When set, refuse `?token=` query authentication for installer compatibility. |

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
| `TERRENCE_RECOVERY_RETENTION_MS` | `604800000` (7 days) | Retention for interrupted-apply recovery records. |
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
| `TERRAFORM_CONFIG_INSPECT_PATH` | bundled | Path to the config inspector binary. |
| `TERRAFORM_TEST_BINARY_PATH` | none | Path for the module test binary. |
| `SENTINEL_BINARY_PATH` | none | Path to the policy engine binary. |
| `GPG_BINARY_PATH` | system | Path to the GPG binary for provider signing keys. |
| `TERRENCE_STACK_IAC_BINARY` | `terraform` | IaC binary for stack runs. |
| `TERRENCE_STACK_IAC_VERSION` | `latest` | IaC binary version for stack runs. |
| `TERRENCE_SANDBOX_EXTRA_RW_ALLOW_STORAGE` | off | Allow extra sandbox read-write paths under the storage directory. |
| `TERRENCE_BINARY_PROBE_TIMEOUT_MS` | `10000` | Timeout for probing an IaC binary version. |
| `TERRENCE_AGENT_FORWARD_TIMEOUT_MS` | `60000` | Agent forward deadline. Clamped to 1s..300s. |
| `TERRENCE_COMPATIBILITY_VERSION` | `2.5.0` | Advertised TFE compatibility version. Keep dotted: the tfe provider feature gates fail on release-style strings. |

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
|---|---|
| `TERRENCE_NODE_ID` | `terrence-node-1` | Node identity reported in readiness responses. |
| `TERRENCE_NODE_ADDRESS` | none | Node address reported in readiness responses. |
| `TERRENCE_NODE_STATUS` | active | Override the readiness status. `draining` or `maintenance` marks the node as draining. |

## Test simulation

Simulation hooks for the test suite. They bypass real IaC execution and must never be set in production.

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
