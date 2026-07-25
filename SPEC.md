# Terrence - Specification

## 1. Overview
This project aims to be a cleanroom, open-source reimplementation of Terraform Enterprise (TFE) designed specifically for homelabbers. It provides a lightweight, easy-to-deploy, yet feature-complete (for MVP) alternative to Terraform Cloud/Enterprise.

The application is deployed as a single Docker container, with a unified frontend and backend. It emulates the standard TFE API to maintain compatibility with the `cloud` backend block in Terraform/OpenTofu.

## 2. Architecture Stack
- **Runtime:** Bun
- **Backend Framework:** Elysia (Fast, lightweight, excellent TypeScript support)
- **Database ORM:** Drizzle ORM
- **Database:** SQLite (default for homelab ease), designed with abstractions to allow Postgres scaling later.
- **Frontend:** React + Vite + Tailwind CSS + Shadcn UI
- **Execution Engine:** Local child processes running `terraform` or `tofu` binaries natively on the host/container. No complex Docker-in-Docker agent orchestration required for MVP.
- **Storage:** Local file system (SQLite Blobs or mounted volumes) for State and Configuration archives. Can be abstracted for S3 later.

## 3. Emulated API Contracts (TFE API V2)
To natively support `terraform login` and the `cloud` block, we must implement the exact TFE API endpoints for the MVP features.

### 3.1 Service Discovery
- `GET /.well-known/terraform.json`
  - Returns the service discovery configuration pointing to our API endpoints (e.g., `{"tfe.v2.1": "/api/v2/", "state.v2": "/api/v2/"}`).

### 3.2 Organizations
- `GET /api/v2/organizations`
- `GET /api/v2/organizations/:org_name`
- `POST /api/v2/organizations`

### 3.3 Workspaces
- `GET /api/v2/organizations/:org_name/workspaces`
- `POST /api/v2/organizations/:org_name/workspaces`
- `GET /api/v2/organizations/:org_name/workspaces/:workspace_name`
- `GET /api/v2/workspaces/:workspace_id`

### 3.4 State Versions & Locking
- `GET /api/v2/workspaces/:workspace_id/current-state-version`
- `POST /api/v2/workspaces/:workspace_id/state-versions`
- `POST /api/v2/workspaces/:workspace_id/actions/lock`
- `POST /api/v2/workspaces/:workspace_id/actions/unlock`

### 3.5 Configuration Versions
- `POST /api/v2/workspaces/:workspace_id/configuration-versions`
- `GET /api/v2/configuration-versions/:cv_id`
- `PUT <upload_url>` (from config version creation for uploading tar.gz of code)

### 3.6 Runs (Plan & Apply)
- `POST /api/v2/runs`
- `GET /api/v2/runs/:run_id`
- `POST /api/v2/runs/:run_id/actions/apply`
- `POST /api/v2/runs/:run_id/actions/discard`
- `POST /api/v2/runs/:run_id/actions/cancel`
- `GET /api/v2/runs/:run_id/plan`

### 3.7 Variables
- `GET /api/v2/workspaces/:workspace_id/vars`
- `POST /api/v2/workspaces/:workspace_id/vars`

### 3.8 VCS (GitHub MVP)
- `POST /api/v2/oauth-clients` (Registering GitHub App/OAuth)
- `GET /api/v2/oauth-tokens`
- Webhook receiver endpoint: `/api/webhooks/github`

## 4. Run State Machine
When a Run is created (either via API or VCS push), it follows this lifecycle:

1. **`pending`**: Run is queued.
2. **`planning`**: Background worker executes `terraform plan`.
3. **`planned`**: Plan succeeded. Awaiting manual approval (if workspace `auto_apply` is false).
4. **`applying`**: Background worker executes `terraform apply`.
5. **`applied`**: Apply succeeded.
6. **`errored`**: Plan or Apply failed.
7. **`discarded`**: Run was discarded by user before applying.
8. **`canceled`**: Run was forcefully stopped during execution.

## 5. Execution Model
1. Run is picked up by a background task manager (e.g., a simple queue implementation in Bun).
2. A temporary directory is created.
3. The Configuration Version (tar.gz) is downloaded and extracted into the temp dir.
4. An `override.tf` or environment variables are injected to configure the backend to point to our local API (using a temporary internal token).
5. Variables from the Workspace are injected as environment variables (`TF_VAR_name`) or via a generated `.tfvars` file.
6. Subprocess (`Bun.spawn`) executes:
   - `tofu init`
   - `tofu plan -out=tfplan`
   - `tofu apply tfplan`
7. Standard output (stdout/stderr) is streamed into the database or log files, which the UI reads from.
8. Upon completion, the temp directory is cleaned up.

## 6. Database Schema (Conceptual - Drizzle)
- **Users**: ID, Username, PasswordHash.
- **Organizations**: ID, Name.
- **Workspaces**: ID, Name, OrgID, TerraformVersion, AutoApply, Locked.
- **WorkspaceVariables**: ID, WorkspaceID, Key, Value, Sensitive, Category (terraform vs env).
- **ConfigurationVersions**: ID, WorkspaceID, Status, ArchivePath.
- **StateVersions**: ID, WorkspaceID, Serial, StatePayload (JSON or FilePath).
- **Runs**: ID, WorkspaceID, ConfigurationVersionID, Status, Message, IsDestroy.
- **Logs**: ID, RunID, Phase (plan/apply), OutputText.

## 7. Next Steps (Development Phase)
1. Scaffold Bun + Elysia backend.
2. Scaffold Vite + React frontend.
3. Implement SQLite Drizzle schema.
4. Implement TDD test suite covering the API contract.
