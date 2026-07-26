# Terrence - Master TODO List

This document serves as a comprehensive tracker for achieving rough feature parity with Terraform Enterprise (TFE). It is broken down into logical epics and modules.

## Epic 1: Core API & Service Discovery
- [x] Implement `/.well-known/terraform.json` service discovery endpoint.
- [x] Implement generic error handling and TFE-compliant `application/vnd.api+json` response formatting.
- [x] Setup API rate limiting and basic security middleware.

## Epic 2: Authentication & Authorization (Local Auth MVP)
- [x] Database schema for Users, Organizations, and Organization Memberships.
- [x] User registration and local password authentication.
- [x] Generation of User API Tokens (`terraform login`).
- [x] Generation of Team/Organization API Tokens.
- [x] Authentication middleware for parsing Bearer tokens and identifying the active user/agent.

## Epic 3: Organization & Workspace Management
- [x] CRUD API for Organizations (`/api/v2/organizations`).
- [x] CRUD API for Workspaces (`/api/v2/organizations/:org/workspaces`).
- [ ] Workspace settings management (Execution Mode, Auto-Apply, Terraform Version).
- [x] Lock/Unlock Workspace APIs.
- [ ] Support for Workspace Tags.

## Epic 4: Variable Management
- [x] Database schema for Variables (Workspace, Variable Set).
- [x] CRUD API for Workspace Variables (`/api/v2/workspaces/:workspace_id/vars`).
- [x] Support for Terraform variables vs. Environment variables.
- [x] Secure storage mechanism for Sensitive variables (HCL vs Env).
- [ ] CRUD API for Variable Sets (Global/Org level) and attachment to workspaces.

## Epic 5: State Management
- [x] Database schema for State Versions and State Outputs.
- [x] Implement `GET /api/v2/workspaces/:workspace_id/current-state-version`.
- [x] Implement `POST /api/v2/workspaces/:workspace_id/state-versions` (State Upload).
- [ ] Storage backend abstraction (Local SQLite Blobs/Filesystem first, S3 later).
- [ ] Fetching specific state versions and state diffing APIs.

## Epic 6: Configuration Versions (Code Uploads)
- [x] Database schema for Configuration Versions.
- [x] API to create a Configuration Version and generate a pre-signed upload URL.
- [x] Ingestion endpoint to receive `tar.gz` configuration payloads.
- [ ] Worker task to extract, validate, and archive the uploaded configuration.
- [ ] Storage backend abstraction for archived configuration versions.

## Epic 7: The Run Pipeline & Execution Engine
- [x] Database schema for Runs, Plans, Applies, and Logs.
- [x] API to trigger a new Run (`POST /api/v2/runs`).
- [x] API to fetch Run status and details (`GET /api/v2/runs/:run_id`).
- [x] API to cancel or discard a Run.
- [x] API to manually approve a Plan and queue an Apply.
- [x] Background Queue System for task orchestration.
- [x] **Worker**: Subprocess execution of `terraform init` and `terraform plan`.
- [x] **Worker**: Subprocess execution of `terraform apply`.
- [ ] Injection of Workspace Variables, Variable Sets, and backend configurations into the worker environment.
- [ ] Log streaming: Capture stdout/stderr from subprocesses and stream to database/filesystem.
- [ ] API to fetch/stream Run Logs for the UI (`/api/v2/runs/:run_id/plan/log`).

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
- [ ] Authentication Views (Login, Setup).
- [x] Organization & Dashboard Views.
- [x] Workspace List and Creation View.
- [x] Workspace Detail View (Overview, Settings).
- [x] Variables Management View (Table, Add/Edit Modal).
- [ ] Run History List View.
- [ ] Single Run View (Status tracker, Real-time log viewer, Approve/Discard buttons).
- [ ] State History View.

## Epic 12: Deployment & Operations
- [ ] Dockerfile for a multi-stage unified build (Bun + Vite frontend built into single container).
- [ ] Database migration execution on container startup.
- [ ] Configuration via Environment Variables (Port, DB Path, Log Level).
- [ ] Support external Postgres database connection.
