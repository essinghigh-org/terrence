# Terrence

A clean-room reimplementation of Terraform Enterprise (TFE) in TypeScript, built on Bun + Elysia + React.

## Architecture

```
terrence/
├── backend/          # Elysia API server (Bun + Hono-like Elysia)
│   ├── src/
│   │   ├── routes/   # API route handlers (JSON:API format)
│   │   ├── db/       # Database schema (Drizzle ORM + SQLite)
│   │   ├── lib/      # Shared utilities (response helpers, auth, cost estimation)
│   │   └── worker.ts # Background run executor (OpenTofu/Terraform)
│   ├── drizzle/      # Drizzle migrations
│   └── tests/        # Backend test suite (289 tests)
├── frontend/         # React 19 + Vite + shadcn/ui
│   ├── src/
│   │   ├── views/    # Page-level components (Dashboard, Workspaces, Runs...)
│   │   ├── components/ # Reusable UI components
│   │   └── lib/      # API client, auth utilities
│   └── tests/        # Integration tests (36 tests)
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

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `STORAGE_DIR` | `./backend/storage` | SQLite DB and artifact storage |
| `DATABASE_URL` | `file:./backend/storage/terrence.db` | SQLite connection string |
| `GITHUB_APP_ID` | — | GitHub App ID for VCS integration |
| `GITHUB_APP_PRIVATE_KEY` | — | GitHub App private key |
| `GITHUB_WEBHOOK_SECRET` | — | GitHub webhook secret |
| `SESSION_KEY` | auto-generated | Session encryption key |

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

- **Workspaces** — Create, configure, lock/unlock, manage VCS connections
- **Runs** — Plan and apply with OpenTofu/Terraform
- **State** — View, download, and manage Terraform state versions
- **Variables** — Terraform and environment variables per workspace or variable set
- **Variable Sets** — Reusable variable collections scoped to workspaces
- **Team Management** — RBAC via teams with org, project, and workspace permissions
- **SSH Keys** — Upload and assign SSH keys to workspaces
- **Notification Configurations** — Webhook, email, and Slack notifications
- **Policy Sets** — OPA/Rego policy enforcement per workspace
- **Run Triggers** — Cross-workspace dependency triggers
- **Cost Estimation** — Infracost integration for plan cost estimates
- **Admin Dashboard** — User, org, workspace, and run management
- **OAuth Clients** — VCS provider integration
- **Agent Pools** — Remote execution agents
- **No-Code Provisioning** — Registry module deployments
- **GitHub App Integration** — Auto-trigger runs on push/PR

## API

The API follows the TFE JSON:API spec. The full specification is documented in [SPEC.md](./SPEC.md).

## Testing

```bash
# Backend (289 tests, 1928 assertions)
cd backend && bun test

# Frontend (36 tests, 168 assertions)
cd frontend && bun test
```

## GitHub App Integration

See [README > GitHub App Integration](#github-app-integration) above for setup instructions.

## License

MIT
