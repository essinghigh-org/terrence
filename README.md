# Terrence

Terrence is a self-hosted platform for running OpenTofu and Terraform workflows, written in TypeScript and running on Bun, Elysia, and React.

> **Not an official product.** Terrence is an independent, open-source project. It is not affiliated with, endorsed by, or sponsored by HashiCorp or any of its products (Terraform, Terraform Cloud, or Terraform Enterprise). "Terraform" is used here only to describe compatibility with the open configuration language and the JSON:API request/response format that the Terraform CLI and related open-source tooling speak. Terrence implements that format independently from publicly available specifications, and does not reuse any vendor source code, trademarks, or proprietary assets.

## Architecture

```
terrence/
├── backend/          # Elysia API server (Bun)
│   ├── src/
│   │   ├── routes/   # API route handlers (JSON:API format)
│   │   ├── db/       # Database schema (Drizzle ORM + SQLite)
│   │   ├── lib/      # Shared utilities (response helpers, auth, cost estimation)
│   │   └── worker.ts # Background run executor (OpenTofu/Terraform)
│   ├── drizzle/      # Drizzle migrations
│   └── tests/        # Backend test suite
├── frontend/         # React 19 + Bun.build + Tailwind CSS
│   ├── src/
│   │   ├── views/    # Page-level components (Dashboard, Workspaces, Runs...)
│   │   ├── components/ # Reusable UI components
│   │   └── lib/      # API client, auth utilities
│   └── tests/        # Integration tests
└── Dockerfile        # Multi-stage Docker build
```

## Quick Start

```bash
# Install dependencies
bun install

# Start the backend dev server
cd backend && bun run index.ts

# Build the frontend (static SPA served by backend)
cd frontend && bun run build

# Run all tests
cd backend && bun test
cd frontend && bun test

# Type-check the backend
cd backend && bun run typecheck
```

## Development

### Prerequisites

- **Bun** >= 1.4.0 (install via `curl -fsSL https://bun.sh/install | bash`)
- **OpenTofu** >= 1.7 or **Terraform** >= 1.9 (for run execution)
- **Infracost** >= 0.10 (optional, for cost estimation)

### Environment Variables

Terrence runs with no environment variables in development. All supported variables:

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
| `INFRACOST_VERSION` | `0.10.45` | Infracost version to use. Managed on demand into `<STORAGE_DIR>/binaries/infracost/<version>/` (digest-verified, like tofu/terraform); bump without a rebuild. |
| `INFRACOST_BINARY` | — | Optional absolute path override for the Infracost executable; when set, it is used as-is instead of the managed binary in `INFRACOST_VERSION`. |
| `GITHUB_APP_ID` | — | GitHub App ID for VCS integration |
| `GITHUB_APP_SLUG` | — | GitHub App slug |
| `GITHUB_APP_PRIVATE_KEY` | — | GitHub App RSA private key |
| `GITHUB_WEBHOOK_SECRET` | — | Exact secret configured in the GitHub App's Webhooks settings; required to accept `/api/webhooks/github` deliveries |
| `GITHUB_APP_HTTP_URL` | `https://github.com` | GitHub Enterprise HTTP URL |
| `GITHUB_APP_API_URL` | `https://api.github.com` | GitHub Enterprise API URL |
| `ADMIN_PASSWORD` | — | Bootstrap admin password on first start (min 10 chars); used when local signup is disabled. |
| `TERRENCE_ENABLE_LOCAL_SIGNUP` | — | When `true`, enable account registration via `POST /api/v2/users`. Default off; only `ADMIN_PASSWORD` bootstrap creates the first admin. |
| `TERRENCE_DISABLE_WORKER` | — | When `1`, run UI/API without the worker (drain mode). Pending runs stay queued until the flag is removed and the service restarted. |
| `TERRENCE_WORKER_POLL_MS` | `1500` | Worker queue poll interval in ms. Invalid, empty, or sub-100ms values fall back to 1500. Lower is snappier but queries the DB more often; raise on low-power homelab boxes. |
| `TERRENCE_VERSION_CACHE_TTL_MS` | `86400000` | How long fetched tofu/terraform version lists are reused (ms). The tofu path paginates the full GitHub release history, so a long TTL avoids refetching after restarts; set 0 to never reuse a cached list (always re-fetch). |
| `TERRAFORM_CONFIG_INSPECT_PATH` | bundled image binary or `PATH` | Optional path to the `terraform-config-inspect` binary used when publishing registry modules. |

### Database Migrations

```bash
cd backend
bun drizzle-kit push:sqlite  # Apply pending migrations
bun drizzle-kit generate     # Generate migration from schema changes
```

## Docker

```bash
# Build the production image
docker build -t terrence .

# Run with persistent storage
docker run -p 3000:3000 -v ./storage:/app/backend/storage terrence
```

The image runs as the unprivileged `nonroot` user (uid 65532, Wolfi). When
bind-mounting `./storage`, the host directory must be owned by uid 65532 (or
world-writable), otherwise the app cannot write its database. Named volumes
(see `docker-compose.yml`) inherit the correct ownership automatically.

Verify a running container executes as `nonroot`:

```bash
backend/scripts/verify-container-user.sh <container-name>
```

## Features

- **Workspaces**: Create, configure, lock/unlock, manage VCS connections
- **Runs**: Plan and apply with OpenTofu/Terraform
- **State**: View, download, and manage Terraform state versions
- **Variables**: Terraform and environment variables per workspace or variable set
- **Variable Sets**: Reusable variable collections scoped to workspaces
- **Team Management**: RBAC via teams with org, project, and workspace permissions
- **SSH Keys**: Upload and assign SSH keys to workspaces
- **Notification Configurations**: Webhook, email, and Slack notifications
- **Policy Sets**: Sentinel and OPA/Rego policy enforcement per workspace

Terrence evaluates policies at run time after plan generation. Each policy set
kind uses its own execution tool, so the supported capability differs by kind:

- **Sentinel** (the default policy kind): evaluated with the
  `sentinel apply` CLI against the generated plan JSON, which is exposed as
  the `tfplan` global. Policy-set parameters are passed as `-param` entries
  and evaluation is bounded by a 30 second timeout. Set
  `SENTINEL_BINARY_PATH` to pin a specific binary. VCS-synced sets must carry
  a `sentinel.hcl` manifest and at least one `.sentinel` file.
- **OPA/Rego**: evaluated with the `opa eval` CLI, which receives the
  generated plan JSON as `--input`. A policy whose evaluated result contains
  a non-empty `violations` array marks the check as failed. VCS-synced sets
  must contain at least one `.rego` file.

Both CLIs must be installed on the worker host (`opa` and `sentinel` on
`PATH`). A check whose evaluation tool is missing or errors is recorded as
`errored` rather than silently passing. Each policy's enforcement level
(`hard-mandatory`, `soft-mandatory`, or `advisory`) decides whether a failed
check blocks the run.
- **Run Triggers**: Cross-workspace dependency triggers
- **Cost Estimation**: Infracost integration for plan cost estimates
- **Admin Dashboard**: User, org, workspace, and run management
- **OAuth Clients**: VCS provider integration
- **Agent Pools**: Remote execution agents
- **No-Code Provisioning**: Registry module deployments
- **Private Registry**: VCS-backed and manual module publication; see [private registry operations](docs/private-registry.md)
- **GitHub App Integration**: Auto-trigger runs on push/PR

### Authentication & single sign-on

Terrence supports three external identity providers in addition to local
username/password accounts. All of them are configured by site administrators
under **Admin → Authentication** in the dashboard (or via the JSON:API admin
settings endpoints), and only take effect once enabled there.

- **SAML 2.0**: SP-initiated SSO with signed HTTP-POST assertions, SP metadata
  at `/users/saml/metadata`, single logout, group→team/owner mapping, and
  certificate rotation (old cert accepted during transitions).
- **OpenID Connect / OAuth2**: Discovery-based IdP configuration, PKCE (S256)
  authorization code flow, and ID token verification against the provider's
  JWKS.
- **LDAP**: Bind + search against a directory (plain, StartTLS, or LDAPS),
  configurable bind DN, base DN, user filter with the `{{username}}`
  placeholder, and attribute mapping for username/email/display name.
- **Local authentication**: Can be disabled entirely via the **"Allow local
  password authentication"** toggle in the same settings. When disabled,
  enabled SAML, OIDC, and LDAP providers can still sign in. The login page, the
  CLI (`terraform login`) authorizer, and the login API all honor this setting.
- **Provisioning conflicts**: External identities are mapped by
  (provider, subject). A verified email links to an existing account only when
  the provider's link-by-email setting is enabled; otherwise a new account is
  created. A username that belongs to a different local account blocks sign-in
  with a clear error instead of silently taking it over. Auto-provisioned
  accounts receive an unusable password hash, so SSO identities can never sign
  in with local credentials.

The public `GET /api/v2/ping` endpoint reports `local-auth-enabled` and the
enabled state of each provider under `sso`, so clients can render the correct
login UI.

For GitHub commit statuses, the GitHub App also needs repository **Commit statuses: Read and write** permission. After changing App permissions, reinstall or approve the updated installation.

## API

The API speaks the JSON:API request/response format used by Terraform CLI remote operations and related open-source tooling, so existing automation that targets that format keeps working unchanged. Terrence aims to stay behaviorally compatible with that documented format. Where public descriptions of different HashiCorp-managed products disagree, Terrence follows the self-hosted-flavored interpretation of the open format.

## Documentation

Terrence ships its own documentation instead of linking to external vendor docs. The documents live in `backend/docs/` as markdown files and are bundled into the container image.

In the running product:

- Open the Documentation section in the sidebar, or press Ctrl+K and search.
- `GET /api/v2/docs` lists the index; `GET /api/v2/docs/:slug` returns one document.
- Both endpoints require authentication.

When adding a document, give it frontmatter with `title`, `category`, `order`, and `description`, and keep the plain technical style used by the existing documents.

## Testing

```bash
# Backend
cd backend && bun test

# Frontend
cd frontend && bun test
```

## License

MIT
