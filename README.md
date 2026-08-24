<h1 align="center">Terrence</h1>

<p align="center">
  <strong>The open-source Terraform and OpenTofu runner you host yourself.</strong><br/>
  Plan, apply, and review infrastructure changes from a web UI — no cloud account required.
</p>

<p align="center">
  <a href="https://github.com/essinghigh-org/terrence/blob/master/LICENSE"><img alt="License" src="https://img.shields.io/github/license/essinghigh-org/terrence?style=flat-square&color=3F51B5"></a>
  <a href="https://github.com/essinghigh-org/terrence/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/essinghigh-org/terrence?style=flat-square"></a>
  <a href="https://github.com/essinghigh-org/terrence/pkgs/container/terrence"><img alt="GHCR package" src="https://img.shields.io/badge/image-ghcr.io-2088FF?style=flat-square&logo=docker&logoColor=white"></a>
  <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/essinghigh-org/terrence/ci.yml?branch=master&label=CI&style=flat-square">
  <a href="https://github.com/essinghigh-org/terrence/security/code-scanning"><img alt="Code scanning" src="https://img.shields.io/github/issues/security/essinghigh-org/terrence?label=code%20scanning&style=flat-square"></a>
</p>

<p align="center">
  <a href="#quick-start">Get started</a> ·
  <a href="#what-it-does">Features</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="https://github.com/essinghigh-org/terrence/issues">Issues</a>
</p>

---

## Why Terrence

Terraform Cloud shut down its free tier. Terraform Enterprise costs more than most homelabs spend on hardware. The usual alternatives are a shared `terraform apply` in Slack and a prayer.

Terrence gives you the missing middle: a self-hosted run platform that speaks the same API your existing tooling already expects. Your state lives on your storage. Your runs execute on your hardware. Your team gets a real interface for reviewing plans before they touch production.

- **Your infrastructure, your rules** — state, logs, and variables stay in your database on your hardware, not a vendor's cloud.
- **Drop-in compatible** — the JSON:API format the Terraform CLI speaks means `terraform login`, CI pipelines, and tfc-agent-style workers work without rewrites.
- **Runs with guardrails** — policy checks (Sentinel or OPA) gate every plan, with hard-mandatory rules that block bad applies.
- **One container** — SQLite by default, single Docker image, runs fine on a homelab box.

<div align="center">
  <img src="docs/demo.gif" alt="Terrence in action: signing in, browsing workspaces, and applying a run">
</div>

## What it does

| | |
|---|---|
| **Workspaces** | Organize infrastructure into workspaces with VCS connections, locking, and run history. |
| **Plan & apply** | Every change goes through plan review. Apply from the UI with one click. |
| **Remote runs** | Execute OpenTofu/Terraform on the server or scale out with agent pools. |
| **State management** | Versioned state storage with browsing, downloads, and outputs inspection. |
| **Variables** | Workspace and environment variables plus reusable variable sets. |
| **Policy enforcement** | Sentinel and OPA/Rego checks evaluated after every plan. Failed hard-mandatory policies block the apply. |
| **Cost estimates** | Optional Infracost integration can price plans when enabled and the binary is available. |
| **Notifications** | Webhooks, email, and Slack when runs need attention. |
| **SSO** | SAML 2.0, OIDC, and LDAP sign-in with group-to-team mapping. Local auth can be disabled entirely. |
| **Private registry** | Publish and version Terraform modules from your own repos. No-code provisioning deploys them to new workspaces. |
| **GitHub App** | Auto-trigger runs on push or pull request, with commit statuses back on the PR. |
| **RBAC & teams** | Organization, project, and workspace-level permissions. |

## Quick start

Run it with Docker:

```bash
mkdir -p ./storage && sudo chown 65532:65532 ./storage   # image runs as nonroot
docker run -d --name terrence -p 3000:3000 \
  -e ADMIN_PASSWORD="pick-a-long-password" \
  -v ./storage:/app/backend/storage \
  ghcr.io/essinghigh-org/terrence:latest
```

Open `http://localhost:3000`, sign in as `admin` with the password you set, create an organization, and connect a workspace.

> **Run sandbox:** run execution requires Landlock (Linux >= 5.13). The container is fail-closed by default — if your host cannot provide Landlock, add `-e TERRENCE_RUN_SANDBOX=0` (or use the bundled `docker-compose.unsandboxed.yml` override). Without isolation or an explicit opt-out, runs stay queued.

Or with compose:

```bash
git clone https://github.com/essinghigh-org/terrence.git && cd terrence
ADMIN_PASSWORD="pick-a-long-password" GITHUB_WEBHOOK_SECRET="a-webhook-secret" \
  docker compose up -d
```

Both variables pass through to the container via compose interpolation (`${...:-}` placeholders in `docker-compose.yml`). The first admin is created from `ADMIN_PASSWORD` on first boot. To allow open registration instead of (or alongside) the bootstrap admin, set `TERRENCE_ENABLE_LOCAL_SIGNUP=true`.

### Developing

Prerequisites: **Bun** >= 1.4.0, plus OpenTofu >= 1.7 or Terraform >= 1.9 on the worker host (Infracost >= 0.10 optional, for cost estimation).

```bash
bun install                                  # Bun >= 1.4.0
(cd frontend && bun run build)               # static SPA served by the backend
(cd backend && bun run index.ts)             # dev server on :3000
```

Run the test suites with `cd backend && bun test` and `cd frontend && bun test`. After schema changes, generate migrations with `bun drizzle-kit generate` in `backend/` — never write them by hand.

## How it works

```text
┌──────────────┐    JSON:API     ┌─────────────────────────────┐
│  Terraform   │◄───────────────►│  Terrence                   │
│  CLI / CI    │                 │  ┌───────────────────────┐  │
│  tfc-agent   │                 │  │ Web UI (React)        │  │
└──────────────┘                 │  │ API server (Elysia)   │  │
                                 │  │ Run worker            │  │
┌──────────────┐                 │  │   ├── tofu/terraform  │  │
│ GitHub / GitLab│◄──────────────►│  │   ├── Sentinel / OPA  │  │
│ (VCS webhooks)│   webhooks      │  │   └── Infracost       │  │
└──────────────┘                 │  └───────────────────────┘  │
                                 │  SQLite + file storage      │
                                 └─────────────────────────────┘
```

Everything runs inside one container. The worker executes plans against your chosen CLI binary (managed automatically, digest-verified), evaluates policies, stores state versions, and reports progress back to the UI over live events.

## API compatibility

The API speaks the JSON:API request/response format used by Terraform CLI remote operations and related open-source tooling, so automation targeting that format works unchanged. Terrence aims to stay behaviorally compatible with the documented format; where public descriptions disagree, it follows the self-hosted interpretation.

> **Not an official product.** Terrence is an independent, open-source project. It is not affiliated with, endorsed by, or sponsored by HashiCorp or any of its products (Terraform, Terraform Cloud, or Terraform Enterprise). "Terraform" appears here only to describe compatibility with the open configuration language and the documented wire format that the Terraform CLI and related tooling speak. Terrence implements that format independently from publicly available specifications and does not reuse any vendor source code, trademarks, or proprietary assets.

## Documentation

Terrence ships its own documentation instead of linking to vendor docs. The documents live in `backend/docs/` as markdown and are bundled into the container image.

In a running instance:

- Open **Documentation** in the sidebar, or press Ctrl+K and search.
- `GET /api/v2/docs` lists the index; `GET /api/v2/docs/:slug` returns one document. Both require authentication.

When adding a document, give it frontmatter with `title`, `category`, `order`, and `description`, and keep the plain technical style used by the existing documents.

See also [private registry operations](docs/private-registry.md).

## Environment variables

Terrence runs with none of these set in development. Production deployments usually only need `ADMIN_PASSWORD`.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | `development` | Set to `production` for production mode |
| `DATABASE_URL` | `file:./storage/terrence.db` | SQLite database path |
| `STORAGE_DIR` | `./storage` | Directory for state archives and binaries |
| `PUBLIC_URL` | — | Public URL for webhook callbacks (required for GitHub App) |
| `CORS_ORIGIN` | — | CORS origin (defaults to `http://localhost:5173` in non-production) |
| `SESSION_KEY` | auto-generated | Session encryption key |
| `INFRACOST_ENABLED` | `false` | Enable Infracost for cost estimation |
| `INFRACOST_VERSION` | `0.10.45` | Infracost version, managed on demand into `<STORAGE_DIR>/binaries/infracost/<version>/` (digest-verified); bump without a rebuild |
| `INFRACOST_BINARY` | — | Absolute path override for the Infracost executable; used as-is instead of the managed binary |
| `GITHUB_APP_ID` | — | GitHub App ID for VCS integration |
| `GITHUB_APP_SLUG` | — | GitHub App slug |
| `GITHUB_APP_PRIVATE_KEY` | — | GitHub App RSA private key |
| `GITHUB_WEBHOOK_SECRET` | — | Exact secret configured in the GitHub App's webhook settings; required for `/api/webhooks/github` deliveries |
| `GITHUB_APP_HTTP_URL` | `https://github.com` | GitHub Enterprise HTTP URL |
| `GITHUB_APP_API_URL` | `https://api.github.com` | GitHub Enterprise API URL |
| `ADMIN_PASSWORD` | — | Bootstrap admin password on first start (min 10 chars); used when local signup is disabled |
| `TERRENCE_ENABLE_LOCAL_SIGNUP` | — | When `true`, enable account registration via `POST /api/v2/users`. Default off; only `ADMIN_PASSWORD` bootstrap creates the first admin |
| `TERRENCE_DISABLE_WORKER` | — | When `1`, run UI/API without the worker (drain mode). Pending runs stay queued until the flag is removed and the service restarted |
| `TERRENCE_WORKER_POLL_MS` | `1500` | Worker queue poll interval in ms. Invalid, empty, or sub-100ms values fall back to 1500. Raise on low-power boxes to query the DB less often |
| `TERRENCE_VERSION_CACHE_TTL_MS` | `86400000` | How long fetched tofu/terraform version lists are reused (ms). Set 0 to always re-fetch |
| `TERRAFORM_CONFIG_INSPECT_PATH` | bundled image binary or `PATH` | Path to `terraform-config-inspect`, used when publishing registry modules |

## Operations notes

<details>
<summary><strong>Container user & storage permissions</strong></summary>

The image runs as the unprivileged `nonroot` user (uid 65532, Wolfi distroless base). When bind-mounting `./storage`, the host directory must be owned by uid 65532 (e.g. `chown -R 65532:65532 ./storage`), otherwise the app cannot write its database. Avoid world-writable permissions — that directory holds your database, state archives, and managed binaries. Named volumes in `docker-compose.yml` inherit the correct ownership automatically.

Verify a running container executes as `nonroot`:

```bash
backend/scripts/verify-container-user.sh <container-name>
```

</details>

<details>
<summary><strong>Policy enforcement details</strong></summary>

Terrence evaluates policies at run time after plan generation. Each policy set kind uses its own execution tool:

- **Sentinel** (the default kind): evaluated with `sentinel apply` against the generated plan JSON, exposed as the `tfplan` global. Policy-set parameters pass as `-param` entries; evaluation is bounded by a 30 second timeout. Set `SENTINEL_BINARY_PATH` to pin a binary. VCS-synced sets must carry a `sentinel.hcl` manifest and at least one `.sentinel` file.
- **OPA/Rego**: evaluated with `opa eval`, receiving the plan JSON as `--input`. A result containing a non-empty `violations` array marks the check failed. VCS-synced sets must contain at least one `.rego` file.

Each selected CLI must be available to the worker — on `PATH`, or at the configured override (`SENTINEL_BINARY_PATH` for Sentinel). A check whose tool is missing or errors records as `errored` — it never silently passes. Enforcement level (`hard-mandatory`, `soft-mandatory`, `advisory`) decides whether a failed check blocks the run.

</details>

<details>
<summary><strong>Authentication & SSO details</strong></summary>

All providers are configured by site administrators under **Admin → Authentication** and only take effect once enabled there.

- **SAML 2.0**: SP-initiated SSO with signed HTTP-POST assertions, SP metadata at `/users/saml/metadata`, single logout, group→team/owner mapping, certificate rotation (old cert accepted during transitions).
- **OIDC/OAuth2**: discovery-based configuration, PKCE (S256) authorization code flow, ID token verification against the provider's JWKS.
- **LDAP**: bind + search (plain, StartTLS, or LDAPS), configurable bind DN/base DN/user filter with `{{username}}`, attribute mapping for username/email/display name.
- **Local authentication**: disable entirely with the **"Allow local password authentication"** toggle. When off, enabled SSO providers still work — the login page, `terraform login` authorizer, and login API all honor the setting.
- **Provisioning conflicts**: external identities map by (provider, subject). A verified email links to an existing account only when the provider's link-by-email setting is on; otherwise a new account is created. A username belonging to a different local account blocks sign-in with a clear error instead of silently taking it over. Auto-provisioned accounts get an unusable password hash, so SSO identities can never sign in locally.

`GET /api/v2/ping` reports `local-auth-enabled` and each provider's state under `sso`, so clients can render the correct login UI.

For GitHub commit statuses, the GitHub App also needs repository **Commit statuses: Read and write** permission. After changing App permissions, reinstall or approve the updated installation.

</details>

## License

MIT — see [LICENSE](LICENSE).
