# Terrence

Terrence is a Terraform Enterprise (TFE) alternative written in TypeScript, running on Bun, Elysia, and React.

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
├── frontend/         # React 19 + Vite + shadcn/ui
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

- **Bun** >= 1.3 (install via `curl -fsSL https://bun.sh/install | bash`)
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
| `TERRENCE_VERSION_CACHE_TTL_MS` | `86400000` | How long fetched tofu/terraform version lists are reused (ms). The tofu path paginates the full GitHub release history, so a long TTL avoids refetching after restarts; set 0 to disable caching. |

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

## Features

- **Workspaces**: Create, configure, lock/unlock, manage VCS connections
- **Runs**: Plan and apply with OpenTofu/Terraform
- **State**: View, download, and manage Terraform state versions
- **Variables**: Terraform and environment variables per workspace or variable set
- **Variable Sets**: Reusable variable collections scoped to workspaces
- **Team Management**: RBAC via teams with org, project, and workspace permissions
- **SSH Keys**: Upload and assign SSH keys to workspaces
- **Notification Configurations**: Webhook, email, and Slack notifications
- **Policy Sets**: OPA/Rego policy enforcement per workspace
- **Run Triggers**: Cross-workspace dependency triggers
- **Cost Estimation**: Infracost integration for plan cost estimates
- **Admin Dashboard**: User, org, workspace, and run management
- **OAuth Clients**: VCS provider integration
- **Agent Pools**: Remote execution agents
- **No-Code Provisioning**: Registry module deployments
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

The API follows the **Terraform Enterprise** (TFE) JSON:API spec, the self-hosted product, not Terraform Cloud. Where TFE and Terraform Cloud disagree, Terrence implements the TFE behavior; endpoints, attributes, and error shapes are kept compatible with `go-tfe` so existing TFE tooling works unchanged. The full specification is documented in [SPEC.md](./SPEC.md).

## Testing

```bash
# Backend
cd backend && bun test

# Frontend
cd frontend && bun test
```

## License

MIT