# Terrence - Master TODO List

This document serves as a comprehensive tracker for achieving rough feature parity with Terraform Enterprise (TFE). It is broken down into logical epics and modules.

## Epic 1: Core API & Service Discovery
- [x] Implement `/.well-known/terraform.json` service discovery endpoint.
- [x] Implement generic error handling and TFE-compliant `application/vnd.api+json` response formatting.
- [x] Setup API rate limiting and basic security middleware.

## Epic 2: Authentication & Authorization (Local Auth MVP)
- [x] Database schema for Users, Organizations, and Organization Memberships.
- [x] User registration endpoint (`POST /api/v2/users`).
- [x] User login and API token generation (`POST /api/v2/users/login`).
- [x] Organization/Team API token generation (`POST /api/v2/tokens`).
- [x] Authentication middleware for parsing Bearer tokens and identifying the active user/agent.
- [x] Auth guard macro (`isAuth`) for protecting routes.

## Epic 3: Organization & Workspace Management
- [x] Create organization (`POST /api/v2/organizations`).
- [x] List organizations (`GET /api/v2/organizations`).
- [x] Get organization by name (`GET /api/v2/organizations/:org_name`).
- [ ] Update organization (`PATCH /api/v2/organizations/:org_name`).
- [ ] Delete organization (`DELETE /api/v2/organizations/:org_name`).
- [x] Create workspace under organization (`POST /api/v2/organizations/:org_name/workspaces`).
- [x] List workspaces in organization (`GET /api/v2/organizations/:org_name/workspaces`).
- [x] Get workspace by name (`GET /api/v2/organizations/:org_name/workspaces/:workspace_name`).
- [x] Get workspace by ID (`GET /api/v2/workspaces/:workspace_id`).
- [ ] Update workspace settings (`PATCH /api/v2/workspaces/:workspace_id`) — Execution Mode, Auto-Apply, Terraform Version.
- [ ] Delete workspace (`DELETE /api/v2/workspaces/:workspace_id`).
- [x] Lock workspace (`POST /api/v2/workspaces/:workspace_id/actions/lock`).
- [x] Unlock workspace (`POST /api/v2/workspaces/:workspace_id/actions/unlock`).
- [ ] Workspace tags (schema, API endpoints, and UI).

## Epic 4: Variable Management
- [x] Database schema for workspace variables.
- [x] Create workspace variable (`POST /api/v2/workspaces/:workspace_id/vars`).
- [x] List workspace variables (`GET /api/v2/workspaces/:workspace_id/vars`).
- [ ] Get individual variable (`GET /api/v2/workspaces/:workspace_id/vars/:var_id`).
- [ ] Update variable (`PATCH /api/v2/workspaces/:workspace_id/vars/:var_id`).
- [ ] Delete variable (`DELETE /api/v2/workspaces/:workspace_id/vars/:var_id`).
- [x] Support for Terraform variables vs. Environment variables (`category` field).
- [x] Sensitive variable support (value hidden in API responses).
- [ ] CRUD API for Variable Sets (Global/Org level) with workspace attachment.

## Epic 5: State Management
- [x] Database schema for State Versions.
- [x] Fetch current state version (`GET /api/v2/workspaces/:workspace_id/current-state-version`).
- [x] Create state version (`POST /api/v2/workspaces/:workspace_id/state-versions`).
- [ ] Storage backend abstraction (Local SQLite blobs/filesystem first, S3 later).
- [ ] Fetch specific state version by ID.
- [ ] State version listing and diffing APIs.

## Epic 6: Configuration Versions (Code Uploads)
- [x] Database schema for Configuration Versions.
- [x] Create configuration version with upload URL (`POST /api/v2/workspaces/:workspace_id/configuration-versions`).
- [x] Get configuration version (`GET /api/v2/configuration-versions/:cv_id`).
- [x] Upload configuration payload (`PUT /api/v2/configuration-versions/:cv_id/upload`).
- [ ] Worker task to extract, validate, and archive uploaded configuration.
- [ ] Storage backend abstraction for archived configuration versions.

## Epic 7: The Run Pipeline & Execution Engine
- [x] Database schema for Runs.
- [x] Trigger a new run (`POST /api/v2/runs`).
- [x] Fetch run status (`GET /api/v2/runs/:run_id`).
- [x] Cancel a run (`POST /api/v2/runs/:run_id/actions/cancel`).
- [x] Discard a run (`POST /api/v2/runs/:run_id/actions/discard`).
- [x] Approve and queue an apply (`POST /api/v2/runs/:run_id/actions/apply`).
- [ ] Background queue system for task orchestration (currently inline fire-and-forget).
- [ ] **Worker**: Subprocess execution of `terraform init` and `terraform plan` (currently mocked with `setTimeout`).
- [ ] **Worker**: Subprocess execution of `terraform apply` (currently mocked with `setTimeout`).
- [ ] Injection of workspace variables, variable sets, and backend configs into worker environment.
- [ ] Log streaming: Capture stdout/stderr from subprocesses and stream to database/filesystem.
- [ ] API to fetch/stream run logs (`/api/v2/runs/:run_id/plan/log`).

## Epic 8: Version Control System (VCS) Integrations
- [ ] OAuth Client registration API for GitHub/GitLab.
- [ ] OAuth handshake flows to obtain VCS tokens.
- [ ] Link a Workspace to a VCS repository and branch.
- [ ] Ingress Webhook endpoint to receive Push and Pull Request events.
- [ ] Webhook processor to automatically create Configuration Versions and trigger Runs on push.
- [ ] Report Commit Status API back to the VCS provider (e.g., GitHub Checks API).

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
- [x] Login view with username/password authentication.
- [x] Organization dashboard view with org listing.
- [x] Workspace list view with table.
- [ ] Workspace creation form (dialog or dedicated view — button exists but non-functional).
- [x] Workspace detail view with variables management.
- [x] Variables management (table display and add modal with category/sensitive support).
- [ ] Run history list view.
- [ ] Single run view (status tracker, real-time log viewer, approve/discard controls).
- [ ] State history view.

## Epic 12: Deployment & Operations
- [x] Dockerfile for multi-stage unified build (Bun + Vite frontend into single container).
- [ ] Database migration execution on container startup.
- [ ] Configuration via environment variables (Port, DB path, log level).
- [ ] External PostgreSQL database connection support.
