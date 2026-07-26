# Terrence - Master TODO List

This document serves as a comprehensive tracker for achieving rough feature parity with Terraform Enterprise (TFE). It is broken down into logical epics and modules.

## Epic 1: Core API & Service Discovery
- [x] Implement `/.well-known/terraform.json` service discovery endpoint.
- [x] Implement generic error handling and TFE-compliant `application/vnd.api+json` response formatting.
- [x] Setup API rate limiting and basic security middleware.

## Epic 2: Authentication & Authorization (Local Auth MVP)
- [x] Database schema for Users, Organizations, and Organization Memberships with cascade deletions.
- [x] User registration endpoint (`POST /api/v2/users`).
- [x] User login and API token generation (`POST /api/v2/users/login`).
- [x] Organization/Team API token generation (`POST /api/v2/tokens`).
- [x] Authentication middleware for parsing Bearer tokens and identifying the active user/agent.
- [x] Auth guard macro (`isAuth`) and organization membership permission checks (`checkOrgPermission`).

## Epic 3: Organization & Workspace Management
- [x] Create organization (`POST /api/v2/organizations`).
- [x] List organizations (`GET /api/v2/organizations`).
- [x] Get organization by name (`GET /api/v2/organizations/:org_name`).
- [x] Update organization (`PATCH /api/v2/organizations/:org_name`) with 409 Conflict handling.
- [x] Delete organization (`DELETE /api/v2/organizations/:org_name`) with transactional cascade deletion.
- [x] Create workspace under organization (`POST /api/v2/organizations/:org_name/workspaces`).
- [x] List workspaces in organization (`GET /api/v2/organizations/:org_name/workspaces`).
- [x] Get workspace by name (`GET /api/v2/organizations/:org_name/workspaces/:workspace_name`).
- [x] Get workspace by ID (`GET /api/v2/workspaces/:workspace_id`).
- [x] Update workspace settings (`PATCH /api/v2/workspaces/:workspace_id`) — Execution Engine (`tofu` vs `terraform`), Auto-Apply, Terraform/OpenTofu Version.
- [x] Delete workspace (`DELETE /api/v2/workspaces/:workspace_id`).
- [x] Lock workspace (`POST /api/v2/workspaces/:workspace_id/actions/lock`).
- [x] Unlock workspace (`POST /api/v2/workspaces/:workspace_id/actions/unlock`).
- [x] Workspace tags (schema, unique indices, API endpoints, and UI).

## Epic 4: Variable Management
- [x] Database schema for workspace variables.
- [x] Create workspace variable (`POST /api/v2/workspaces/:workspace_id/vars`).
- [x] List workspace variables (`GET /api/v2/workspaces/:workspace_id/vars`).
- [x] Get individual variable (`GET /api/v2/workspaces/:workspace_id/vars/:var_id`).
- [x] Update variable (`PATCH /api/v2/workspaces/:workspace_id/vars/:var_id`) with sensitive toggle protection.
- [x] Delete variable (`DELETE /api/v2/workspaces/:workspace_id/vars/:var_id`).
- [x] Support for Terraform variables vs. Environment variables (`category` field).
- [x] Sensitive variable support (value hidden in API responses).
- [ ] CRUD API for Variable Sets (Global/Org level) with workspace attachment.

## Epic 5: State Management
- [x] Database schema for State Versions (serial, state payload) with unique `(workspace_id, serial)` composite index.
- [x] Fetch current state version (`GET /api/v2/workspaces/:workspace_id/current-state-version`).
- [x] Create state version (`POST /api/v2/workspaces/:workspace_id/state-versions`) with atomic transaction serial allocation.
- [x] Add FilePath storage option for state payloads and configuration archives.
- [x] Storage backend abstraction (Local filesystem).
- [x] Fetch specific state version by ID (`GET /api/v2/state-versions/:state_version_id`).
- [x] State version listing with pagination (`page[size]`, `page[number]`) and payload download APIs.

## Epic 6: Configuration Versions (Code Uploads)
- [x] Database schema for Configuration Versions.
- [x] Add `archive_path` field to schema.
- [x] Create configuration version with upload URL (`POST /api/v2/workspaces/:workspace_id/configuration-versions`).
- [x] Get configuration version (`GET /api/v2/configuration-versions/:cv_id`).
- [x] Upload configuration payload (`PUT /api/v2/configuration-versions/:cv_id/upload`).
- [x] Worker task to extract, validate, and archive uploaded configuration (`tar.gz` -> temp directory with path traversal guard).
- [x] Storage backend abstraction for archived configuration versions.

## Epic 7: The Run Pipeline & Execution Engine
- [x] Database schema for Runs with `createdAt` index.
- [x] Add `configuration_version_id` foreign key to Runs schema.
- [x] Add `is_destroy` flag to Runs schema.
- [x] Trigger a new run (`POST /api/v2/runs`).
- [x] Fetch run status (`GET /api/v2/runs/:run_id`).
- [x] Cancel a run (`POST /api/v2/runs/:run_id/actions/cancel`).
- [x] Discard a run (`POST /api/v2/runs/:run_id/actions/discard`).
- [x] Approve and queue an apply (`POST /api/v2/runs/:run_id/actions/apply`).
- [x] Fetch plan JSON output (`GET /api/v2/runs/:run_id/plan`).
- [x] **Logs database schema** (ID, RunID, Phase, OutputText) with composite `(run_id, phase)` index for fast log streaming.
- [x] Background queue system for task orchestration.
- [x] **Worker**: Create temporary workspace directory per run and clean up on completion.
- [x] **Worker**: Extract configuration version (`tar.gz`) into temporary directory with path traversal protection.
- [x] **Worker**: Inject workspace variables as `TF_VAR_` environment variables with sanitized host process environment.
- [x] **Worker**: Subprocess execution of `tofu init` / `terraform init`.
- [x] **Worker**: Subprocess execution of `tofu plan -out=tfplan` / `terraform plan`.
- [x] **Worker**: Subprocess execution of `tofu apply tfplan` / `terraform apply`.
- [x] **Worker**: Stream stdout/stderr from subprocesses concurrently into Logs database table.
- [x] **Worker**: Report final status back to Runs table (`applied` / `errored`).
- [x] API to fetch/stream run logs (`/api/v2/runs/:run_id/plan/log`, `/apply/log`) with 404 validation.
- [x] **Dynamic Terraform/OpenTofu version management**: Download, verify SHA256 checksums, cache, and select specific binary versions per workspace.
- [x] Support runtime selection between Terraform (`terraform`) and OpenTofu (`tofu`) per workspace with organization-level fallback inheritance.

## Epic 8: Version Control System (VCS) Integrations
- [ ] Register OAuth client (`POST /api/v2/oauth-clients`) for GitHub/GitLab.
- [ ] OAuth handshake flows to obtain VCS tokens.
- [ ] List OAuth tokens (`GET /api/v2/oauth-tokens`).
- [ ] Link a workspace to a VCS repository and branch.
- [ ] Ingress webhook endpoint (`/api/webhooks/github`) to receive push and PR events.
- [ ] Webhook processor to auto-create configuration versions and trigger runs on push.
- [ ] Report commit status back to VCS provider (e.g., GitHub Checks API).

## Epic 9: Private Registry (Modules & Providers)
- [ ] Module Registry API discovery.
- [ ] API to publish, version, and download private Terraform modules.
- [ ] Provider Registry API discovery (Network mirror support).
- [ ] API to publish and serve private Terraform providers.

## Epic 10: Policy as Code (Sentinel / OPA) - Phase 2
- [ ] Integration into the Run Pipeline (Plan -> Policy Check -> Apply).
- [ ] Upload and manage Policy Sets.
- [ ] Worker integration to execute Open Policy Agent (OPA) against the JSON plan output.

## Epic 11: Frontend & User Interface

### Core Views
- [x] Login view with username/password authentication.
- [x] Organization dashboard view with org listing.
- [x] Workspace list view with table (name, version, auto-apply, lock status).
- [x] Workspace creation modal (`CreateWorkspaceModal`) with engine selection and version inputs.
- [x] Workspace detail view with variables management.
- [x] Variables management (table display and add/delete modal with category/sensitive support and confirmation guards).
- [x] Run history list view.
- [x] Single run view (status tracker, log viewer, parameterized action handlers).
- [x] State history view with authenticated Blob downloads and fetch-on-demand JSON viewer.

### TFE UI Mirroring & Polish
- [x] Workspace overview tab with key metadata (execution engine, version, status).
- [x] Run timeline / progress indicator matching TFE's run state visualization with dynamic error state highlights.
- [x] Real-time log viewer for stdout/stderr execution output.
- [x] Consistent TFE color scheme, typography, and spacing.
- [x] Responsive layout for desktop use.
- [x] Navigation breadcrumbs (Org > Workspace > Runs).

## Epic 12: Deployment & Operations
- [x] Dockerfile for multi-stage unified build (Bun + Vite frontend into single container).
- [x] Architectural build arguments (`ARG TARGETARCH`) and SHA256 checksum verification for CLI downloads.
- [x] Production database migration execution on container startup (`drizzle-kit migrate`).
- [x] Dedicated unprivileged container user (`USER appuser`) and `VOLUME ["/app/backend/storage"]` persistence declaration.
- [x] Bundled both `tofu` (OpenTofu) and `terraform` CLI binaries.
- [x] Configuration via environment variables.

## Epic 13: End-to-End Testing
- [x] Integration test: User registration -> login -> create org -> create workspace -> full lifecycle.
- [x] Integration test: Create variable -> trigger run -> verify plan output -> apply -> verify applied state.
- [x] Integration test: State version upload -> retrieve current state -> verify serial increments.
- [x] Integration test: Configuration version upload -> verify status transitions.
- [x] Integration test: Lock workspace -> verify locked -> unlock -> verify unlocked.
- [x] Integration test: Cancel and discard run mid-pipeline.
- [x] Integration test: Sensitive variable values are hidden in API responses.
