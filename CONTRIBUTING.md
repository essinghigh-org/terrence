# Contributing to Terrence

## Getting Started

1. Clone the repository
2. Ensure Bun 1.4.0 is installed
3. Run `bun install` at the project root (this also installs the pre-commit hook)
4. Build the frontend: `(cd frontend && bun run build)`
5. Run `(cd backend && bun run index.ts)` to start the server
6. Open `http://localhost:3000` to access the UI

## Development Workflow

### Pre-commit Hook

A pre-commit hook keeps the database schema and its migrations in lockstep. It is automatically installed via `bun run prepare` upon `bun install`, or can be linked manually:
```bash
ln -sf ../../scripts/pre-commit .git/hooks/pre-commit
```

### Code Style

- **TypeScript strict mode** is enforced. Run `cd backend && bun run typecheck` before committing.
- **ESLint** is configured for both backend and frontend. Run `cd backend && bun run lint` (if available).
- **Prettier** formatting is not enforced — use your editor defaults.

### Testing

- All code changes must maintain or improve test coverage.
- Run **all tests** before opening a PR:
  ```bash
  cd backend && bun test
  cd frontend && bun test
  ```
- Write tests alongside new features.
- Existing test patterns:
  - **Backend**: Elysia route tests using `bun:test` with `app.handle()`
  - **Frontend**: React Testing Library with mocked `fetch` via `bun:test-mock`
  - **Flow tests**: `frontend/tests/flows.test.tsx` — integration-level UI flows

### Compatibility ownership

The ownership manifest in `backend/src/data/compatibility_ownership.json` is the source of truth for major surfaces:

- `core` is first-class Terrence product functionality.
- `provider` is backend/API behavior retained for the official `hashicorp/tfe` provider and does not imply a WebUI.
- `cli` is behavior required by Terraform/OpenTofu remote workflows.
- `internal` covers operation, security, administration, and integration infrastructure.

Do not implement an HCP Terraform or Terraform Enterprise API solely for parity. A new compatibility endpoint must be justified by the official `hashicorp/tfe` provider, Terraform/OpenTofu CLI behavior, or a concrete Terrence product requirement.

### Commit Conventions

Use conventional commits:

| Prefix | Purpose |
|---|---|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `chore:` | Tooling, CI, dependencies |
| `docs:` | Documentation |
| `refactor:` | Code restructuring |
| `test:` | Test additions/modifications |
| `style:` | Formatting, styling |

### Pull Request Process

1. Create a feature branch from `master`
2. Make focused, reviewable commits
3. Run `cd backend && bun run typecheck` — must produce **0 errors**
4. Run `cd backend && bun test` — all **289 tests** must pass
5. Run `cd frontend && bun test` — all **36 tests** must pass
6. Open a PR against `master`

## Architecture Notes

### Backend

- **Framework**: [Elysia](https://elysiajs.com/) — a Bun-native HTTP framework
- **Database**: SQLite via [Drizzle ORM](https://orm.drizzle.team/)
- **API Format**: JSON:API (compatible with the Terraform CLI remote-workflow format)
- **Auth**: Bearer token with session rotation
- **Run Execution**: Background worker using `Bun.spawn()` for OpenTofu/Terraform

Key directories:
- `backend/src/routes/` — Route handlers organized by resource
- `backend/src/db/schema.ts` — All table definitions
- `backend/src/lib/` — Shared utilities (auth, cost estimation, pagination)
- `backend/drizzle/` — Database migrations

### Frontend

- **Framework**: React 19 + TypeScript
- **Build**: Bun native bundler (`Bun.build`) with `bun-plugin-tailwind`
- **UI**: Tailwind CSS UI components (built on Radix UI)
- **Testing**: `bun:test` + `Bun.WebView` browser testing + axe-core accessibility
- **State**: Local state with `useState`/`useEffect` — no global state manager
- **API Client**: Custom `fetchApi()` wrapper with token refresh

Key patterns:
- Views live in `frontend/src/views/` as page-level components
- Reusable UI in `frontend/src/components/`
- API calls use the `fetchApi()` helper from `frontend/src/lib/api.ts`
- Response caching is not used — every view fetches fresh data on mount

### Run Pipeline

1. User creates a run via API
2. Backend inserts a run record (status: `pending`)
3. Worker picks up the run, clones/fetches the config
4. Worker invokes OpenTofu/Terraform via `Bun.spawn()`
5. Output is streamed to run logs
6. Cost estimate is generated (via Infracost if available)
7. On completion, status transitions to `planned` / `applied` / `errored`

## Environment Setup

```bash
# Development
cp backend/.env.example backend/.env  # if available
# Defaults work out of the box with SQLite

# VCS Integration (GitHub App)
export GITHUB_APP_ID="..."
export GITHUB_APP_PRIVATE_KEY="..."
export GITHUB_WEBHOOK_SECRET="..."
```

## Troubleshooting

### TypeScript Errors

```bash
cd backend && bun run typecheck
```

Should produce **0 errors** in strict mode. If you see new errors, check:
- Are you mutating a DB row directly? Use `Record<string, unknown>` for dynamic fields
- Are you using `$inferSelect`/`$inferInsert`? Cast to `Record<string, unknown>` for mutation

### Test Failures

- **Flaky tests**: Run `bun test --rerun-each 3` to detect flakiness
- **Frontend test timeouts**: Check that mock fetch handles all expected URLs
- **DB locked errors**: Ensure no other process has the SQLite DB open

### Docker Build

```bash
docker build --no-cache -t terrence .
```

If SHA256 verification fails for tofu/terraform/infracost, the binary versions may need updating in the Dockerfile.
