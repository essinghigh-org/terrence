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
- [ ] Generation of Team/Organization API Tokens.
- [ ] Authentication middleware for parsing Bearer tokens and identifying the active user/agent.

## Epic 3: Organization & Workspace Management
- [ ] CRUD API for Organizations (`/api/v2/organizations`).
- [ ] CRUD API for Workspaces (`/api/v2/organizations/:org/workspaces`).
- [ ] Workspace settings management (Execution Mode, Auto-Apply, Terraform Version).
- [ ] Lock/Unlock Workspace APIs.
- [ ] Support for Workspace Tags.

## Epic 4: Variable Management
- [ ] Database schema for Variables (Workspace, Variable Set).
- [ ] CRUD API for Workspace Variables (`/api/v2/workspaces/:workspace_id/vars`).
- [ ] Support for Terraform variables vs. Environment variables.
- [ ] Secure storage mechanism for Sensitive variables (HCL vs Env).
- [ ] CRUD API for Variable Sets (Global/Org level) and attachment to workspaces.

## Epic 5: State Management
- [ ] Database schema for State Versions and State Outputs.
- [ ] Implement `GET /api/v2/workspaces/:workspace_id/current-state-version`.
- [ ] Implement `POST /api/v2/workspaces/:workspace_id/state-versions` (State Upload).
- [ ] Storage backend abstraction (Local SQLite Blobs/Filesystem first, S3 later).
- [ ] Fetching specific state versions and state diffing APIs.

## Epic 6: Configuration Versions (Code Uploads)
- [ ] Database schema for Configuration Versions.
- [ ] API to create a Configuration Version and generate a pre-signed upload URL.
- [ ] Ingestion endpoint to receive `tar.gz` configuration payloads.

- [ ] Single Run View (Status tracker, Real-time log viewer, Approve/Discard buttons).
- [ ] State History View.

## Epic 12: Deployment & Operations
- [ ] Dockerfile for a multi-stage unified build (Bun + Vite frontend built into single container).
- [ ] Database migration execution on container startup.
- [ ] Configuration via Environment Variables (Port, DB Path, Log Level).
- [ ] Support external Postgres database connection.
