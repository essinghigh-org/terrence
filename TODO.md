# Terrence — TFE Feature Parity TODO

> **Goal:** A self-hostable, Dockerized, single-container reimplementation of Terraform Enterprise (TFE) that supports the `cloud` backend block and `terraform login` natively.
>
> This document exhaustively catalogs every TFE API endpoint, feature, and capability from the official TFE documentation. Items are organized by priority and grouped into epics. Checkboxes track implementation status.

---

## Epic 0: Core API Infrastructure

### 0.1 Response Formatting & Standards
- [x] TFE-compliant `application/vnd.api+json` Content-Type on all responses
- [x] JSON API spec error objects (`{ errors: [{ status, title, detail }] }`)
- [x] Proper HTTP status codes (200, 201, 202, 204, 400, 401, 403, 404, 409, 422, 429, 500)
- [x] Return 404 for resources the user doesn't have access to (security through obscurity)
- [x] `links` object with `self`, `first`, `prev`, `next`, `last` on paginated responses
- [x] `meta.pagination` object with `current-page`, `prev-page`, `next-page`, `total-pages`, `total-count`
- [x] `include` query parameter for related resource embedding
- [x] Proper percent-encoding handling for query params with `[]` characters
- [x] CORS headers for frontend API access

### 0.2 Service Discovery
- [x] `GET /.well-known/terraform.json` — returns `{ "tfe.v2.1": "/api/v2/", "state.v2": "/api/v2/" }`
- [x] `GET /.well-known/terraform.json` includes the `tfe.v2` key used by the `cloud` integration
- [x] `GET /.well-known/terraform.json` includes the `tfe.v2.2` key
- [x] `GET /.well-known/terraform.json` includes the `modules.v1` key
- [x] `GET /.well-known/terraform.json` includes the `providers.v1` key
- [x] `GET /api/v2/ping` — TFE API version handshake for the `cloud` backend

### 0.3 Rate Limiting
- [x] 30 requests/second default rate limit with 429 response
- [x] Per-user rate limiting (not per-token)
- [x] Per-IP rate limiting for unauthenticated requests
- [x] `X-RateLimit-Limit` header on responses
- [x] Lower rate limits for sensitive endpoints (auth, notifications, etc.)

### 0.4 System Endpoints (TFE Enterprise)
- [x] `GET /api/v1/ping` — health check returning `"pong"` (requires auth)
- [x] `GET /api/v1/readiness` — readiness probe (TFE-specific)
- [x] `GET /api/v1/metadata` — instance metadata (version, build, etc.)

---

## Epic 1: Authentication & Authorization

### 1.1 User Registration & Login
- [x] `POST /api/v2/users` — register new user (username + password)
- [x] `POST /api/v2/users/login` — authenticate and receive bearer token
- [x] Password validation (minimum 10 characters)
- [x] Email field for user registration (optional for homelab MVP)
- [x] 409 Conflict on duplicate username

### 1.2 Bearer Token Authentication
- [x] `Authorization: Bearer <token>` header parsing middleware
- [x] Token lookup in database
- [x] 401 Unauthorized for missing/invalid tokens
- [x] Token types: user tokens, org tokens
- [x] Token types: team tokens
- [x] Token expiry support (`expired-at` field)
- [x] Token last-used-at tracking

### 1.3 User Tokens
- [x] `POST /api/v2/tokens` — create user/organization token
- [x] `GET /api/v2/users/:user_id/authentication-tokens` — list user tokens
- [x] `GET /api/v2/authentication-tokens/:id` — show specific token (metadata only)
- [x] `DELETE /api/v2/authentication-tokens/:id` — delete/revoke a token
- [x] Token descriptions
- [x] Token creation timestamps
- [x] Token expiration support

### 1.4 Organization Tokens
- [x] `POST /api/v2/tokens` with org relationship — create org token
- [x] `GET /organizations/:organization_name/authentication-token` — get org token metadata
- [x] `DELETE /organizations/:organization_name/authentication-token` — destroy org token
- [x] Org tokens have restricted permissions (no plan/apply)

### 1.5 Team Tokens
- [x] `POST /teams/:team_id/authentication-tokens` — create team token (returns secret)
- [x] `GET /teams/:team_id/authentication-tokens` — list team tokens
- [x] `DELETE /teams/:team_id/authentication-tokens/:id` — delete team token
- [x] Team token expiry support
- [x] Team tokens can plan/apply (unlike org tokens)

### 1.6 Account Endpoint (terraform login support)
- [x] `GET /api/v2/account/details` — returns current user/agent identity
- [x] `PATCH /api/v2/account/update` — update username/email
- [x] `PATCH /api/v2/account/password` — change password
- [x] `authenticated-resource` relationship for org/team tokens (synthetic users)
- [x] Permissions object: `can-create-organizations`, `can-change-email`, `can-change-username`
- [x] `login.v1` service discovery for native `terraform login`
- [x] OAuth authorization-code flow with S256 PKCE for native `terraform login`
- [x] Avatar URL support

### 1.7 Authorization Guards
- [x] `isAuth` macro for route protection
- [x] Organization membership permission checks (`checkOrgPermission`)
- [x] Team-based permission checks for workspace access
- [x] Organization-level permission checks (manage-workspaces, manage-vcs-settings, etc.)
- [x] Workspace-level permission checks (read, plan, apply, lock/unlock, admin)
- [x] Owner role auto-assignment on org creation

---

## Epic 2: Organizations

### 2.1 Organization CRUD
- [x] `GET /api/v2/organizations` — list orgs (with pagination, search)
- [x] `GET /api/v2/organizations/:org_name` — show org details
- [x] `POST /api/v2/organizations` — create org
- [x] `PATCH /api/v2/organizations/:org_name` — update org
- [x] `DELETE /api/v2/organizations/:org_name` — delete org with cascade

### 2.2 Organization Attributes & Relationships
- [x] `external-id` field on org
- [x] `email` response attribute (fixed `null`)
- [x] `session-timeout`, `session-remember` response attributes (fixed `null`)
- [x] `collaborator-auth-policy` field (fixed `password`)
- [x] `cost-estimation-enabled` flag (fixed `false`)
- [x] `send-passing-statuses-for-untriggered-speculative-plans` flag (fixed `false`)
- [x] `aggregated-commit-status-enabled` flag (fixed `false`)
- [x] `speculative-plan-management-enabled` flag (fixed `true`)
- [x] `allow-force-delete-workspaces` flag (fixed `true`)
- [x] `default-execution-mode` field
- [x] `default-agent-pool` relationship (fixed `null`)
- [x] `default_iac_binary` field (custom extension — tofu vs terraform)
- [x] `default_terraform_version` field
- [x] `user-tokens-enabled` flag (fixed `true`)
- [x] `oauth-tokens` relationship link
- [x] `authentication-token` relationship link
- [x] `entitlement-set` relationship link
- [x] `subscription` relationship link (no endpoint handler yet — returns link only)

### 2.3 Organization Entitlements
- [x] `GET /organizations/:organization_name/entitlement-set` — show org entitlements
- [x] Entitlements: `operations`, `state-storage`, `policy-enforcement`, `teams`, `vcs-integrations`, `cost-estimation`, `private-module-registry`, `agents`, `sso`, `run-tasks`, `audit-logging`, `self-serve-billing`, `user-limit`
- [x] Entitlement-based feature gating (404 for unentitled features)
- [x] `GET /api/v2/entitlements` — global entitlements list

### 2.4 Organization Tokens (API)
- [x] `GET /organizations/:organization_name/authentication-token` — get org token
- [x] `POST /organizations/:organization_name/authentication-token` — create org token
- [x] `DELETE /organizations/:organization_name/authentication-token` — destroy org token

---

## Epic 3: Users & Teams

### 3.1 User Management
- [x] `GET /api/v2/users/:user_id` — show user details
- [x] `POST /api/v2/users` — create user
- [x] `GET /api/v2/users` — list users (admin)
- [x] `PATCH /api/v2/users/:user_id` — update user
- [x] `DELETE /api/v2/users/:user_id` — delete user
- [x] `is-service-account` attribute on user
- [x] `auth-method` attribute (local, SSO, etc.)
- [x] `avatar-url` attribute
- [x] `v2-only` attribute
- [x] `permissions` object on user

### 3.2 Organization Memberships
- [x] `POST /organizations/:organization_name/organization-memberships` — invite user by email
- [x] `GET /organizations/:organization_name/organization-memberships` — list memberships
- [x] `GET /organization-memberships/:id` — show membership
- [x] `DELETE /organization-memberships/:id` — remove user from org
- [x] Membership status: `invited`, `active`
- [x] Team assignments on invite
- [x] Auto-membership for creator (owner role)

### 3.3 Teams
- [x] `GET /organizations/:organization_name/teams` — list teams (with search, pagination)
- [x] `POST /organizations/:organization_name/teams` — create team
- [x] `GET /teams/:team_id` — show team details
- [x] `PATCH /teams/:team_id` — update team (name, visibility, org-access)
- [x] `DELETE /teams/:team_id` — destroy team
- [x] `visibility` attribute: `secret` or `organization`
- [x] `organization-access` object with fine-grained permissions
- [x] `sso-team-id` attribute
- [x] `users-count` attribute
- [x] `permissions` object on team

### 3.4 Team Membership
- [x] `POST /teams/:team_id/relationships/users` — add users to team (by user ID)
- [x] `POST /teams/:team_id/relationships/organization-memberships` — add users (by org membership ID)
- [x] `DELETE /teams/:team_id/relationships/users` — remove users from team
- [x] `GET /teams/:team_id` with `?include=users` — list team members

### 3.5 Team Access to Workspaces
- [x] `GET /team-workspaces?filter[workspace][id]=:id` — list team access for a workspace
- [x] `POST /team-workspaces` — create team access to workspace
- [x] `PATCH /team-workspaces/:id` — update team access level
- [x] `DELETE /team-workspaces/:id` — remove team access
- [x] Access levels: `read`, `plan`, `write`, `admin`, `custom`
- [x] Custom access sub-permissions: `runs`, `variables`, `state-versions`, `sentinel-mocks`, `workspace-locking`, `run-tasks`, `policy-overrides`

### 3.6 SSO / SAML
- [ ] SAML configuration API (admin)
- [ ] `saml-enabled` flag on organization
- [ ] `owners-team-saml-role-id` field
- [ ] SSO team mapping
- [ ] (Low priority for homelab — omit unless needed)

### 3.7 SCIM
- [ ] SCIM settings API (admin)
- [ ] SCIM tokens
- [ ] SCIM group mapping for teams
- [ ] (Low priority for homelab — omit unless needed)

---

## Epic 4: Projects

### 4.1 Project CRUD
- [x] `GET /organizations/:organization_name/projects` — list projects
- [x] `POST /organizations/:organization_name/projects` — create project
- [x] `GET /projects/:project_id` — show project details
- [x] `PATCH /projects/:project_id` — update project
- [x] `DELETE /projects/:project_id` — delete project (must be empty)

### 4.2 Project Attributes
- [x] `name`, `description` fields
- [x] `default-execution-mode` (remote, local, agent)
- [x] `default-agent-pool` relationship
- [x] `setting-overwrites` object (execution-mode, etc.)
- [x] `auto-destroy-activity-duration`
- [x] Tag bindings on projects (key-value tags)
- [x] Workspace default project (auto-assign to "Default Project")

### 4.3 Project Tag Bindings
- [x] `GET /projects/:project_id/tag-bindings` — list project tags
- [x] `GET /projects/:project_id/effective-tag-bindings` — list all tags (same as above for projects)
- [x] `POST /projects/:project_id/tag-bindings` — add tags
- [x] `DELETE /projects/:project_id/tag-bindings` — remove tags

### 4.4 Workspace → Project Assignment
- [x] `data.relationships.project` on workspace create
- [x] Moving workspace between projects (requires permissions)
- [x] Project-level default execution mode inheritance

---

## Epic 5: Workspaces

### 5.1 Workspace CRUD
- [x] `POST /organizations/:organization_name/workspaces` — create workspace
- [x] `GET /organizations/:organization_name/workspaces` — list workspaces
- [x] `GET /organizations/:organization_name/workspaces/:name` — show workspace by name
- [x] `GET /workspaces/:workspace_id` — show workspace by ID
- [x] `PATCH /workspaces/:workspace_id` — update workspace
- [x] `PATCH /organizations/:organization_name/workspaces/:name` — update workspace by name (TFE API v2.2)
- [x] `DELETE /workspaces/:workspace_id` — force delete workspace
- [x] `DELETE /organizations/:organization_name/workspaces/:name` — force delete by name
- [x] `POST /organizations/:organization_name/workspaces/:name/actions/safe-delete` — safe delete (checks for managed resources)
- [x] `POST /workspaces/:workspace_id/actions/safe-delete` — safe delete by ID

### 5.2 Workspace Attributes (Create/Update)
- [x] `name` — workspace name
- [x] `description` — description field
- [x] `auto-apply` — auto-apply on successful plan
- [x] `auto-apply-run-trigger` — auto-apply for run-triggered runs
- [x] `terraform-version` — version or constraint
- [x] `iac-binary` — tofu vs terraform selection
- [x] `execution-mode` — standard `remote` mode for built-in execution
- [x] `working-directory` — terraform working directory
- [x] `file-triggers-enabled` — filter runs by changed files
- [x] `trigger-prefixes` — paths to monitor for VCS changes
- [x] `trigger-patterns` — glob patterns for VCS monitoring
- [x] `vcs-repo` — VCS repository configuration (branch, identifier, oauth-token-id, ingress-submodules, tags-regex)
- [x] `queue-all-runs` — immediately queue runs after creation
- [x] `speculative-enabled` — allow speculative plans on PRs
- [x] `allow-destroy-plan` — allow destroy plans on workspace
- [x] `global-remote-state` — share state with all org workspaces
- [x] `project-remote-state` — share state with project workspaces
- [x] `agent-pool-id` — agent pool for agent execution mode
- [x] `assessments-enabled` — (formerly drift detection) health assessments
- [x] `structured-run-output-enabled` — structured JSON output (fixed `false`)
- [x] `auto-destroy-at` — scheduled destroy timestamp
- [x] `auto-destroy-activity-duration` — inactivity-based auto-destroy
- [x] `source-name`, `source-url` — friendly client identification
- [x] `setting-overwrites` — override project-level defaults
- [x] `tag-bindings` relationship — key-value tags on create
- [x] `project` relationship — assign to project

### 5.3 Workspace Lock/Unlock
- [x] `POST /workspaces/:workspace_id/actions/lock` — lock workspace
- [x] `POST /workspaces/:workspace_id/actions/unlock` — unlock workspace
- [x] `POST /workspaces/:workspace_id/actions/force-unlock` — force unlock (admin)
- [x] `locked-reason` attribute on workspace

### 5.4 Workspace Tag Bindings (Key-Value Tags)
- [x] `GET /workspaces/:workspace_id/tag-bindings` — list direct key-value tags
- [x] `GET /workspaces/:workspace_id/effective-tag-bindings` — list all direct tags (including project inheritance)
- [x] `PATCH /workspaces/:workspace_id/tag-bindings` — add or update key-value tag bindings
- [x] Clear key-value tag bindings through the workspace relationship
- [x] Tag inheritance from projects

### 5.5 Workspace Flat String Tags
- [x] Schema and unique indices for workspace tags
- [x] `GET /workspaces/:workspace_id/relationships/tags` — list tags
- [x] `POST /workspaces/:workspace_id/relationships/tags` — add tags
- [x] `DELETE /workspaces/:workspace_id/relationships/tags` — remove tags
- [x] Key-value tags on workspace creation (via `tag-bindings`)
- [x] `tag-names` on workspace responses

### 5.6 Remote State Consumers
- [x] `GET /workspaces/:workspace_id/relationships/remote-state-consumers` — list consumers
- [x] `POST /workspaces/:workspace_id/relationships/remote-state-consumers` — add consumers
- [x] `PATCH /workspaces/:workspace_id/relationships/remote-state-consumers` — replace consumers
- [x] `DELETE /workspaces/:workspace_id/relationships/remote-state-consumers` — remove consumers
- [x] `global-remote-state` and `project-remote-state` flags

### 5.7 SSH Key Assignment
- [x] `PATCH /workspaces/:workspace_id/relationships/ssh-key` — assign SSH key to workspace
- [x] `PATCH /workspaces/:workspace_id/relationships/ssh-key` with `null` — unassign SSH key

### 5.8 Data Retention Policy
- [x] `GET /workspaces/:workspace_id/relationships/data-retention-policy` — show policy
- [x] `POST /workspaces/:workspace_id/relationships/data-retention-policy` — create policy
- [x] `DELETE /workspaces/:workspace_id/relationships/data-retention-policy` — remove policy
- [x] Data retention policy attributes (e.g., number of state versions to keep)

### 5.9 Workspace Run History
- [x] `GET /workspaces/:workspace_id/runs` — list runs (with pagination)
- [x] Filters: `filter[operation]`, `filter[status]`, `filter[source]`, `filter[status_group]`
- [x] Filter: `filter[timeframe]` (supports `year` and specific `YYYY` values)
- [ ] Filter: `filter[agent_pool_names]` (not implemented)
- [x] Search: `search[basic]` (run ID and message)
- [x] Search: `search[user]` (filter by username)
- [x] Search: `search[commit]` (filter by commit SHA in ingress attributes)
- [x] Filter: `filter[agent_pool_names]` (filter by agent pool name)

### 5.10 Workspace Variables (Scoped)
- [x] `GET /workspaces/:workspace_id/vars` — list workspace variables
- [x] `POST /workspaces/:workspace_id/vars` — create workspace variable
- [x] `GET /workspaces/:workspace_id/vars/:var_id` — get variable
- [x] `PATCH /workspaces/:workspace_id/vars/:var_id` — update variable
- [x] `DELETE /workspaces/:workspace_id/vars/:var_id` — delete variable
- [x] `hcl` attribute support (evaluate value as HCL)
- [x] `description` attribute support

### 5.11 Configuration Versions (Scoped)
- [x] `GET /workspaces/:workspace_id/configuration-versions` — list CVs (with pagination)
- [x] `POST /workspaces/:workspace_id/configuration-versions` — create CV (with upload URL)
- [x] `GET /configuration-versions/:cv_id` — show CV
- [x] `PUT /configuration-versions/:cv_id/upload` — upload configuration tar.gz
- [x] `GET /configuration-versions/:cv_id/download` — download configuration
- [x] `GET /configuration-versions/:cv_id/ingress-attributes` — VCS commit info
- [x] CV states: `pending`, `fetching`, `uploaded`, `archived`, `errored`
- [x] `speculative` flag on CV (plan-only runs)
- [x] `provisional` flag persisted (saved plan execution remains open)
- [x] `source` attribute (`tfe-api` for the supported upload path)

---

## Epic 6: Variables & Variable Sets

### 6.1 Deprecated Global `/vars` API
- [x] `POST /api/v2/vars` — create variable (deprecated, use workspace-scoped)
- [x] `GET /api/v2/vars` — list variables (deprecated)
- [x] `PATCH /api/v2/vars/:var_id` — update variable (deprecated)
- [x] `DELETE /api/v2/vars/:var_id` — delete variable (deprecated)

### 6.2 Workspace-Scoped Variables
- [x] Full CRUD via `/workspaces/:workspace_id/vars`
- [x] `category` field: `terraform` or `env`
- [x] `sensitive` field: value hidden in responses
- [x] `hcl` field: evaluate value as HCL
- [x] `description` field

### 6.3 Variable Sets
- [x] Database schema: `variable_sets`, `variable_set_workspaces`, `variable_set_variables`
- [x] `POST /organizations/:organization_name/varsets` — create variable set
- [x] `GET /organizations/:organization_name/varsets` — list variable sets
- [x] `GET /varsets/:varset_id` — show variable set
- [x] `PATCH /varsets/:varset_id` — update variable set
- [x] `DELETE /varsets/:varset_id` — delete variable set
- [x] `POST /varsets/:varset_id/relationships/workspaces` — attach to workspaces
- [x] `DELETE /varsets/:varset_id/relationships/workspaces` — detach from workspaces
- [x] `POST /varsets/:varset_id/relationships/projects` — attach to projects
- [x] `DELETE /varsets/:varset_id/relationships/projects` — detach from projects
- [x] `POST /varsets/:varset_id/relationships/vars` — add variables to set
- [x] `GET /varsets/:varset_id/relationships/vars` — list variables in a set
- [x] `GET /varsets/:varset_id/relationships/vars/:var_id` — read a set variable
- [x] `PATCH /varsets/:varset_id/relationships/vars` — update variables in set
- [x] `DELETE /varsets/:varset_id/relationships/vars` — remove variables from set
- [x] `global` flag persisted on organization variable sets
- [x] Global and workspace-attached variable sets feed worker execution
- [x] `priority` flag — override more specific variables
- [x] `parent` relationship — organization ownership
- [x] Global variable set conflict detection
- [x] Variable set CRUD, global toggle, and workspace attachment UI in frontend
- [x] Reload-safe variable set variable list/create/edit/delete UI

### 6.4 Variable Precedence
- [x] Run-specific variables override workspace variables
- [x] Workspace variables override variable sets
- [x] Variable sets > project default
- [x] Priority variable sets override CLI/command-line values

---

## Epic 7: State Management

### 7.1 State Versions CRUD
- [x] `POST /workspaces/:workspace_id/state-versions` — create state version
- [x] `GET /workspaces/:workspace_id/current-state-version` — get current state
- [x] `GET /state-versions/:sv_id` — show state version
- [x] `GET /workspaces/:workspace_id/state-versions` — list state versions (pagination)
- [x] `DELETE /state-versions/:sv_id` — delete state version (mark for GC)

### 7.2 State Version Attributes
- [x] `serial` — incrementing serial number
- [x] `state` — raw state payload (only on create response; not on GET)
- [x] `md5` — MD5 hash of state
- [x] `lineage` — state lineage UUID
- [x] `json-state` — JSON output format state (stored in `json_state` column on create, accessible via `/json-download`)
- [x] `json-state-outputs` — parsed outputs from JSON state (accessible via outputs endpoint)
- [x] `vcs-commit-sha`, `vcs-commit-url` — VCS commit info (stored in DB, returned in attribute response)
- [x] `terraform-version` — Terraform version that created the state
- [x] `resources-processed` — processing flag
- [x] `resources`, `modules`, `providers` — extracted metadata
- [x] `state-version` — internal state format version
- [x] `status` — accepts `pending` or `finalized`; value stored in DB and returned in attribute
- [x] State version `pending` / `finalized` lifecycle supported (can create as `pending`, set to `finalized`)
- [x] `hosted-state-download-url` — download URL (attribute in response)
- [ ] `hosted-state-download-url` — signed temporal URL pattern (currently direct download)
- [x] `hosted-json-state-download-url` — JSON format download URL (in response attributes when `json_state` exists)
- [ ] `hosted-state-upload-url` — separate upload URL flow (state posted inline instead; attribute returns null)
- [ ] `hosted-json-state-upload-url` — separate JSON upload flow (attribute returns null)
- [x] Separate JSON download endpoint (`GET /state-versions/:sv_id/json-download`)
- [ ] `run` relationship — link state version to run (always null — no run tracking on state versions)

### 7.3 State Version Download
- [x] `GET /state-versions/:sv_id/download` — download raw state (JSON)
- [x] `GET /state-versions/:sv_id/download` returns secure state payload
- [x] JSON state download endpoint (`GET /state-versions/:sv_id/json-download`)
- [x] Upload URL pattern for separate upload flow

### 7.4 State Version Lifecycle
- [x] State version status: `pending` → `finalized` (or `discarded`) — schema supports pending/discarded lifecycle
- [ ] Upload timeout handling (state must be uploaded within window)
- [ ] Workspace locking requirement for state creation (TFE requires lock)
- [ ] Intermediate state versions (snapshots during run)

### 7.5 State Version Outputs
- [x] `GET /state-versions/:sv_id/state-version-outputs` and go-tfe `/outputs` alias — list outputs (with pagination)
- [x] `GET /state-version-outputs/:state_version_output_id` — read an individual output
- [x] `GET /workspaces/:workspace_id/current-state-version-outputs` — go-tfe current output lookup
- [x] Output attributes: `name`, `value`, `sensitive`, `type`

---

## Epic 8: Configuration Versions

### 8.1 Configuration Version CRUD
- [x] `POST /workspaces/:workspace_id/configuration-versions` — create CV
- [x] `GET /workspaces/:workspace_id/configuration-versions` — list CVs
- [x] `GET /configuration-versions/:cv_id` — show CV
- [x] `PUT /configuration-versions/:cv_id/upload` — upload tar.gz

### 8.2 CV Attributes
- [x] `status` — pending, uploading, uploaded, archived, errored
- [x] `archive-path` / upload URL
- [x] `speculative` flag
- [x] `provisional` flag persisted (saved plan execution remains open)
- [x] `source` — `tfe-api` for the supported upload path
- [x] `status-timestamps` object
- [x] `error`, `error-message` fields

### 8.3 CV Commit Info (Ingress Attributes)
- [x] `GET /configuration-versions/:cv_id/ingress-attributes` — VCS commit details
- [x] `commit-sha`, `commit-url`, `commit-message`
- [x] `branch`, `tag`, `pull-request-number`, `sender-username`
- [x] `clone-url`, `compare-url`

### 8.4 CV Lifecycle
- [x] Upload → extracted → archived flow
- [x] Path traversal protection on tar extraction
- [ ] `backing_data_soft_deleted` / `backing_data_permanently_deleted` states (not implemented — no GC lifecycle)
- [x] Re-fetch from VCS for VCS-linked workspaces
- [ ] GC (garbage collection) for old CV archives and backing data

---

## Epic 9: Runs, Plans & Applies

### 9.1 Run CRUD
- [x] `POST /api/v2/runs` — create run
- [x] `GET /api/v2/runs/:run_id` — show run details
- [x] `GET /workspaces/:workspace_id/runs` — list runs in workspace
- [x] `GET /organizations/:organization_name/runs` — list runs across org
- [x] `DELETE /api/v2/runs/:run_id` — delete run

### 9.2 Run Actions
- [x] `POST /runs/:run_id/actions/apply` — approve and queue apply
- [x] `POST /runs/:run_id/actions/discard` — discard run
- [x] `POST /runs/:run_id/actions/cancel` — cancel run
- [x] `POST /runs/:run_id/actions/force-cancel` — force cancel run
- [x] Comment on apply: `{ "comment": "Looks good" }`

### 9.3 Run States (TFE State Machine)

**Phase 1 — States reached by the worker pipeline:**
- [x] `pending` — initial state, claimed by worker queue
- [x] `planning` — plan in progress (worker enters this from `pending`)
- [x] `planned` — plan completed, awaiting apply confirmation
- [x] `planned_and_finished` — plan-only final state (worker enters for plan-only runs)
- [x] `applying` — apply in progress (worker enters after plan + auto-apply)
- [x] `applied` — successfully applied (final)
- [x] `errored` — failed (final)
- [x] `canceled` — canceled by user (final, via actions/cancel)
- [x] `force_canceled` — force canceled by admin (final, via actions/force-cancel)
- [x] `discarded` — discarded by user (final, via actions/discard)
- [x] `policy_soft_failed` — policy soft-fail, requires override before apply (worker enters for soft-mandatory failures)

**Phase 2 — States recognized by DB/API but NEVER auto-transitioned by worker:**
- [ ] `fetching` — fetching config from VCS
- [ ] `fetching_completed` — VCS fetch done
- [ ] `pre_plan_running` — pre-plan phase
- [ ] `pre_plan_completed` — pre-plan done
- [ ] `queuing` — queuing for execution
- [ ] `plan_queued` — waiting for backend capacity
- [ ] `cost_estimating` — cost estimation
- [ ] `cost_estimated` — cost estimation done
- [ ] `policy_checking` — policy evaluation
- [ ] `policy_override` — policy soft fail, awaiting override
- [ ] `policy_checked` — policy evaluation done
- [ ] `confirmed` — user confirmed apply
- [ ] `post_plan_running` — post-plan phase
- [ ] `post_plan_completed` — post-plan done
- [ ] `planned_and_saved` — saved plan ready to confirm
- [ ] `apply_queued` — waiting for backend capacity
- [ ] `unreachable` — agent unreachable (final)

### 9.4 Run Attributes
- [x] `actions` object: `is-cancelable`, `is-confirmable`, `is-discardable`, `is-force-cancelable`
- [x] `has-changes` boolean
- [x] `operation` — enum computed from isDestroy/refreshOnly/planOnly
- [x] `source` — `tfe-api` for the supported run path
- [x] `trigger-reason` — `manual` for the supported run path
- [x] `status-timestamps` — all state transitions with timestamps
- [x] `allow-empty-apply` — allow apply with no changes
- [x] `allow-config-generation` — allow config generation
- [x] `save-plan` — plan without becoming current run
- [x] `permissions` object: can-apply, can-cancel, can-discard, can-force-cancel, can-force-execute, can-override-policy-check
- [x] `can-comment` in permissions object
- [x] `message`, `is-destroy`, `created-at`
- [x] `refresh` — refresh state before plan
- [x] `refresh-only` — refresh without changes
- [x] `replace-addrs` — resource addresses to replace
- [x] `target-addrs` — resource targets
- [x] `configuration-version-id` relationship
- [x] `plan` relationship (link to plan resource)
- [x] `apply` relationship (link to apply resource)
- [x] `workspace` relationship
- [x] `created-by` relationship
- [x] `run-events` relationship
- [ ] `policy-checks` relationship
- [ ] `comments` relationship
- [x] `cost-estimate` relationship link on run resource
- [x] `resource-additions`, `resource-changes`, `resource-destructions` in responses
- [ ] `input-state-version` relationship
- [ ] `workspace-run-alerts` relationship

### 9.5 Run Variables
- [x] Run-specific variables: `data.attributes.variables` array of `{key, value}`
- [x] Variable precedence: run vars > workspace vars
- [x] Variable precedence: workspace vars > variable sets
- [x] Run-level `terraform-version` for plan-only runs

### 9.6 Run Modes
- [x] Plan & apply (standard)
- [x] Run-level auto-apply (`terraform apply -auto-approve`)
- [x] Plan-only / speculative plan
- [x] Destroy run
- [x] Refresh-only run
- [x] Empty apply (state upgrade) — requires `allow-empty-apply` flag (schema, route, and worker support added)
- [x] Saved plan run — requires `save-plan` flag (schema, route, and planned_and_saved status added)
- [x] `allow-empty-apply` accepted in run creation API
- [x] `allow-config-generation` accepted in run creation API
- [x] `save-plan` accepted in run creation API
- [x] Debugging mode (`TF_LOG=TRACE`)

### 9.7 Plans
- [x] `GET /plans/:plan_id` — show plan details
- [x] `GET /runs/:run_id/plan` — plan relationship from run
- [x] `GET /plans/:plan_id/json-output` — JSON plan output
- [x] Plan states: `pending`, `running`, `finished`, `errored`, `canceled`
- [ ] Plan states: `queued`, `unreachable`
- [x] Plan attribute: `has-changes`
- [x] Plan attributes: `resource-additions`, `resource-changes`, `resource-destructions`, `resource-imports` (parsed from plan log output)
- [x] Plan attributes: `generated-configuration`, `execution-details` (`remote` mode)
- [x] Plan `status-timestamps`
- [x] Plan `log-read-url` / log streaming
- [ ] Plan `state-versions` relationship

### 9.8 Applies
- [x] `GET /applies/:apply_id` — show apply details
- [x] `POST /runs/:run_id/actions/apply` — trigger apply
- [x] Apply states: `pending`, `running`, `finished`, `errored`, `canceled`
- [ ] Apply states: `queued`, `unreachable`
- [x] Apply attributes: `resource-additions`, `resource-changes`, `resource-destructions`, `resource-imports` (parsed from apply log output)
- [x] Apply `status-timestamps`
- [x] Apply `log-read-url` / log streaming
- [ ] Apply `state-versions` relationship

### 9.9 Run Logs
- [x] `GET /runs/:run_id/plan/log` — plain-text plan log
- [x] `GET /runs/:run_id/apply/log` — plain-text apply log
- [x] Unauthenticated capability URLs for native go-tfe plan/apply log readers
- [x] Byte offset/limit log chunks for go-tfe `LogReader`
- [x] Logs stored in database with `(run_id, phase)` index
- [x] Concurrent log streaming from subprocess stdout/stderr

### 9.10 Run Queue
- [x] Background worker queue (`startWorkerQueue`)
- [x] `GET /organizations/:org_name/runs/queue` — native Terraform queue polling
- [x] `GET /organizations/:org_name/capacity` — pending/running capacity counts
- [x] Per-workspace serial run queue (one run at a time)
- [x] Pending runs wait for current run to complete
- [x] Speculative/plan-only runs do not block queue
- [x] Saved plan planning does not block queue (speculative/plan-only runs bypass queue)
- [x] Locked workspace: runs created but won't start

### 9.11 Apply Queue
- [x] Apply must wait for plan to complete
- [x] Auto-apply vs manual apply
- [ ] Policy check must pass before apply (if policy enforcement enabled)
- [ ] Cost estimation must complete before apply (if enabled)

---

## Epic 10: Logs & Comments

### 10.1 Run Logs
- [x] Database schema for logs
- [x] Log streaming APIs
- [x] `GET /runs/:run_id/logs` — structured JSON logs endpoint
- [ ] Log retention and GC
- [ ] Chunked/streamed log delivery (for large runs)

### 10.2 Run Comments
- [x] `GET /runs/:run_id/comments` — list comments
- [x] `POST /runs/:run_id/comments` — create comment on run
- [x] `DELETE /comments/:comment_id` — delete comment
- [x] Comment body, author, timestamps

---

## Epic 11: Policy as Code (Sentinel & OPA)

### 11.1 Policy Sets
- [x] `POST /organizations/:organization_name/policy-sets` — create policy set
- [x] `GET /organizations/:organization_name/policy-sets` — list policy sets
- [x] `GET /policy-sets/:policy_set_id` — show policy set
- [x] `PATCH /policy-sets/:policy_set_id` — update policy set
- [x] `DELETE /policy-sets/:policy_set_id` — delete policy set
- [x] `POST /policy-sets/:policy_set_id/relationships/workspaces` — attach to workspaces
- [x] `DELETE /policy-sets/:policy_set_id/relationships/workspaces` — detach
- [x] `POST /policy-sets/:policy_set_id/relationships/projects` — attach to projects
- [x] `DELETE /policy-sets/:policy_set_id/relationships/projects` — detach
- [x] `POST /policy-sets/:policy_set_id/relationships/workspace-exclusions` — exclude workspaces
- [x] `DELETE /policy-sets/:policy_set_id/relationships/workspace-exclusions` — remove exclusions
- [x] `kind` attribute: `sentinel` or `opa`
- [x] `global` flag — apply to all workspaces
- [x] `overridable` flag — allow policy overrides
- [x] `agent-enabled` flag — run policy in HCP Terraform agent
- [x] `policy-tool-version` — specific version for policy evaluation
- [x] `vcs-repo` — VCS connection for policy set source
- [ ] Policy set versions (upload tar.gz)
- [x] `policies-path` — subdirectory within VCS repo
- [x] Policy set attachment to projects via `POST /policy-sets/:id/relationships/projects`
- [x] Policy set workspace exclusions via `POST /policy-sets/:id/relationships/workspace-exclusions`

### 11.2 Policies (Individual)
- [x] `GET /policy-sets/:policy_set_id/policies` — list policies in set
- [x] `GET /policies/:policy_id` — show policy
- [x] `POST /policy-sets/:policy_set_id/policies` — create policy (upload)
- [x] `PATCH /policies/:policy_id` — update policy
- [x] `DELETE /policies/:policy_id` — delete policy
- [x] Policy enforcement level: `hard-mandatory`, `soft-mandatory`, `advisory`

### 11.3 Policy Checks
- [x] `GET /runs/:run_id/policy-checks` — list policy checks for a run
- [x] `GET /policy-checks/:check_id` — show policy check result
- [x] `POST /policy-checks/:check_id/actions/override` — override a soft-failed policy
- [x] Policy check states: `pending`, `running`, `passed`, `failed`, `overridden`, `soft_failed`, `canceled`, `errored`
- [x] Policy check result (pass/fail counts, individual policy results)
- [x] Sentinel result details (`result.sentinel` hash)
- [x] OPA result details

### 11.4 Policy Enforcement in Run Pipeline
- [x] Plan → Policy Check → Apply integration (wired into run pipeline)
- [x] Hard-mandatory: failed policy blocks apply (run → errored)
- [x] Soft-mandatory: failed policy requires override to proceed (run → policy_soft_failed)
- [x] Advisory: failed policy logs warning, doesn't block
- [x] Policy override via `actions/override-policy` endpoint
- [x] OPA policy evaluation in worker (`opa eval` against plan JSON)

### 11.5 Policy Set Parameters
- [x] `GET /policy-sets/:policy_set_id/parameters` — list parameters
- [x] `POST /policy-sets/:policy_set_id/parameters` — create parameter
- [x] `PATCH /parameters/:param_id` — update parameter
- [x] `DELETE /parameters/:param_id` — delete parameter
- [x] Parameters: key, value, sensitive, hcl

### 11.6 OPA Integration
- [x] OPA policy tool version management
- [x] OPA execution in worker (run `opa eval` against plan JSON)
- [x] OPA result parsing

---

## Epic 12: Cost Estimation

### 12.1 Cost Estimates
- [x] `GET /runs/:run_id/cost-estimate` — show cost estimate via run (stub, returns zero costs)
- [x] `GET /cost-estimates/:ce_id` — individual cost estimate by ID endpoint
- [ ] Cost estimate wired into run pipeline (plan → cost estimate → policy check → apply)
- [ ] Cost estimate states: always returns `finished` (no support for `skipped`, `queued`, `pending`, `errored`, `canceled`)
- [x] `prior-monthly-cost`, `proposed-monthly-cost`, `delta-monthly-cost` (stub returns `0.0`)
- [ ] `resources-count`, `matched-resources-count`, `unmatched-resources-count` (not returned by stub)
- [ ] `resources` object (detailed cost breakdown per resource)
- [ ] `error-message` field

### 12.2 Cost Estimation Integration
- [ ] Cost estimation engine (requires cloud provider pricing data)
- [ ] UI display of cost estimates in run view
- [x] (Low priority for homelab — stub implementation or omit)

---

## Epic 13: VCS Integrations

### 13.1 OAuth Clients
- [x] `GET /organizations/:organization_name/oauth-clients` — list OAuth clients
- [x] `POST /organizations/:organization_name/oauth-clients` — create OAuth client
- [x] `GET /oauth-clients/:oc_id` — show OAuth client
- [x] `PATCH /oauth-clients/:oc_id` — update OAuth client
- [x] `DELETE /oauth-clients/:oc_id` — delete OAuth client
- [x] `service-provider` — github, gitlab, bitbucket, github_enterprise, gitlab_ce, gitlab_ee, etc.
- [ ] `service-provider-display-name` — human-readable provider name (not implemented)
- [ ] Additional service providers: `azure_devops_server`, `bitbucket_data_center` (not implemented)
- [x] `api-url`, `http-url` — VCS instance URLs
- [x] `key`, `secret` — OAuth app credentials
- [x] `callback-url`, `connect-path` — OAuth flow URLs
- [x] `rsa-public-key` — SSH key for VCS
- [ ] OAuth handshake flow (redirect to VCS, callback handling) — OAuth CRUD endpoints exist, no actual VCS OAuth flow
- [ ] `projects` relationship — scope OAuth client to projects (schema exists, no API routes)
- [ ] `agent-pool` relationship — private VCS via agent (not implemented)

### 13.2 OAuth Tokens
- [x] `GET /oauth-clients/:oc_id/oauth-tokens` — list tokens for a client
- [x] `GET /oauth-tokens/:ot_id` — show OAuth token
- [x] `DELETE /oauth-tokens/:ot_id` — delete OAuth token
- [x] `service-provider-user` — VCS username
- [x] `has-ssh-key` flag

### 13.3 GitHub App Installations
- [ ] `GET /organizations/:organization_name/github-app-installations` — list installations
- [ ] GitHub App integration flow
- [ ] GitHub App installation ID ↔ workspace linking

### 13.4 Webhook Handling
- [x] `POST /api/webhooks/github` — GitHub push/PR event receiver (returns 200 acknowledged)
- [x] `POST /api/webhooks/gitlab` — GitLab event receiver (returns 200 acknowledged)
- [x] `POST /api/webhooks/bitbucket` — Bitbucket event receiver (returns 200 acknowledged)
- [ ] Actual webhook payload parsing and run triggering
- [ ] Webhook payload parsing and validation
- [ ] Auto-create configuration version on push
- [ ] Auto-trigger run on push (if auto-queue enabled)
- [ ] Speculative plan on PR
- [ ] Trigger filtering by file paths (trigger-prefixes, trigger-patterns, working-directory)
- [ ] Commit status reporting (pending, success, failure)
- [ ] `tags-regex` support — trigger runs on Git tags

### 13.5 VCS Events
- [x] `GET /configuration-versions/:cv_id/ingress-attributes` — commit info from VCS event
- [x] Event metadata: branch, commit SHA, commit message, sender, clone URL

### 13.6 Private VCS via Agent
- [x] Agent-based private VCS connectivity
- [x] (Low priority — requires agent functionality)

---

## Epic 14: SSH Keys

### 14.1 SSH Key CRUD
- [x] `GET /organizations/:organization_name/ssh-keys` — list SSH keys
- [x] `POST /organizations/:organization_name/ssh-keys` — create SSH key
- [x] `GET /ssh-keys/:ssh_key_id` — show SSH key metadata
- [x] `PATCH /ssh-keys/:ssh_key_id` — update SSH key
- [x] `DELETE /ssh-keys/:ssh_key_id` — delete SSH key
- [x] `name` attribute
- [x] Private key is write-only (never returned in responses)
- [ ] Keys stored encrypted at rest

### 14.2 SSH Key Assignment
- [x] Assign to VCS OAuth token (for repo access)
- [x] Assign to workspace (for Git module sources)

---

## Epic 15: Notifications

### 15.1 Workspace Notification Configurations
- [x] `GET /workspaces/:workspace_id/notification-configurations` — list configs
- [x] `POST /workspaces/:workspace_id/notification-configurations` — create config
- [x] `GET /notification-configurations/:nc_id` — show config
- [x] `PATCH /notification-configurations/:nc_id` — update config
- [x] `DELETE /notification-configurations/:nc_id` — delete config
- [x] `POST /notification-configurations/:nc_id/actions/verify` — test notification
- [x] `destination-type`: generic, slack, microsoft-teams
- [x] `url` — webhook URL
- [x] `triggers` array: `run:created`, `run:planning`, `run:needs_attention`, `run:applying`, `run:completed`, `run:errored`, `assessment:drifted`, `assessment:check_failure`, `assessment:failed`, `workspace:auto_destroy_reminder`, `workspace:auto_destroy_run_results`
- [x] `enabled` flag

### 15.2 Team Notification Configurations
- [x] `POST /teams/:team_id/notification-configurations` — create team notification
- [x] Team notification triggers: `team:change_request`
- [x] (Low priority for homelab)

### 15.3 Project Notification Configurations
- [x] Project-level notification configurations
- [x] (Low priority for homelab)

### 15.4 Notification Delivery
- [x] HTTP POST delivery with standardized payload
- [x] Payload versioning
- [x] Retry logic
- [x] (Low priority for homelab)

---

## Epic 16: Agents

### 16.1 Agent Pools
- [x] `GET /organizations/:organization_name/agent-pools` — list pools
- [x] `POST /organizations/:organization_name/agent-pools` — create pool
- [x] `GET /agent-pools/:pool_id` — show pool
- [x] `PATCH /agent-pools/:pool_id` — update pool
- [x] `DELETE /agent-pools/:pool_id` — delete pool
- [x] `name` attribute
- [x] `organization-scoped` flag
- [x] `agent-count` — number of connected agents
- [x] `workspaces` relationship
- [x] `allowed-workspaces` — scope pool to specific workspaces
- [x] `allowed-projects` — scope pool to projects
- [x] `authentication-tokens` relationship

### 16.2 Agent Tokens
- [x] `GET /agent-pools/:pool_id/authentication-tokens` — list tokens for pool
- [x] `POST /agent-pools/:pool_id/authentication-tokens` — create token for pool (hashed at rest)
- [x] `GET /authentication-tokens/:token_id` — show any token (generic endpoint, works for agent tokens)
- [x] `DELETE /authentication-tokens/:token_id` — delete any token (generic endpoint, works for agent tokens)
- [x] `description` attribute on tokens
- [ ] `last-used-at` tracking (schema exists, not updated)

### 16.3 Agent Objects
- [ ] `GET /agent-pools/:pool_id/agents` — list agents in pool
- [ ] `GET /agents/:agent_id` — show agent details
- [ ] `DELETE /agents/:agent_id` — delete agent
- [ ] Agent status: `idle`, `busy`, `exited`, `errored`, `unknown`
- [ ] Agent attributes: `name`, `ip-address`, `last-ping-at`, `version`, `architecture`
- [ ] Agent <> run association

### 16.4 Agent Execution Mode
- [x] Workspace execution-mode: `agent`
- [x] Agent pool assignment on workspace
- [x] Run dispatch to agent pool
- [x] Agent-poll-based job retrieval
- [x] Agent hooks (pre-plan, post-plan, pre-apply, post-apply)
- [x] Agent-based policy evaluation
- [x] (Very low priority for homelab — local execution mode is primary)

---

## Epic 17: Run Tasks

### 17.1 Run Task CRUD
- [x] `GET /organizations/:organization_name/run-tasks` — list tasks
- [x] `POST /organizations/:organization_name/run-tasks` — create task
- [x] `GET /run-tasks/:task_id` — show task
- [x] `PATCH /run-tasks/:task_id` — update task
- [x] `DELETE /run-tasks/:task_id` — delete task
- [x] `name`, `description`, `url`, `category`, `enabled`, `hmac-key`

### 17.2 Run Task Execution
- [x] `GET /workspaces/:workspace_id/run-tasks` — list tasks on workspace
- [x] `POST /workspaces/:workspace_id/run-tasks` — attach task to workspace
- [x] `DELETE /workspaces/:workspace_id/run-tasks/:task_id` — detach
- [x] `GET /runs/:run_id/run-tasks` — list task results for a run
- [x] `GET /run-tasks/:task_id/task-results` — get task result details
- [ ] Pre-plan and post-plan stages
- [ ] HMAC-signed payloads for task callback verification
- [x] (Low priority for homelab)

---

## Epic 18: Private Registry — Modules

### 18.1 Module Registry API (Standard Registry Protocol)
- [x] `GET /api/registry/v1/modules/:namespace/:name/:provider/versions` — list versions
- [x] `GET /api/registry/v1/modules/:namespace/:name/:provider/:version` — get module version
- [x] `GET /api/registry/v1/modules/:namespace/:name/:provider/:version/download` — download source (uses `X-Terraform-Get` header)
- [x] `GET /api/registry/v1/modules/:namespace/:name/:provider` — get latest version
- [x] `GET /api/registry/v1/modules/:namespace/:name` — list providers for module
- [x] `GET /api/registry/v1/modules` — search/browse modules
- [x] `GET /api/registry/v1/modules/:namespace` — list modules in namespace

### 18.2 Module Publishing & Management
- [x] `POST /api/v2/organizations/:org/registry-modules` — publish module from VCS
- [x] `POST /api/v2/organizations/:org/registry-modules/versions` — create module version
- [x] `PUT /api/v2/registry-module-versions/:version_id/upload` — upload module tar.gz
- [x] `DELETE /api/v2/registry-modules/:module_id` — delete module
- [x] `GET /api/v2/registry-modules/:module_id/versions` — list versions
- [x] `PATCH /api/v2/registry-module-versions/:version_id` — update version status
- [x] `DELETE /api/v2/registry-module-versions/:version_id` — delete version
- [x] VCS-driven module publishing
- [ ] No-code provisioning ready modules

### 18.3 Module GPG Keys
- [ ] GPG key management for module signing
- [x] (Low priority for homelab)

### 18.4 Module Tests
- [ ] `POST /registry-modules/:module_id/versions/:version/test` — trigger module test
- [ ] `GET /registry-modules/:module_id/versions/:version/test` — get test results
- [ ] Module test configuration
- [ ] (Low priority for homelab)

---

## Epic 19: Private Registry — Providers

### 19.1 Provider Registry API (Standard Registry)
- [x] `GET /api/registry/v1/providers/:namespace/:type/versions` — list versions
- [x] `GET /api/registry/v1/providers/:namespace/:type/:version/download/:os/:arch` — download URL
- [x] `GET /api/registry/v1/providers/:namespace/:type/:version` — get version details
- [x] `GET /api/registry/v1/providers/-/versions` — search providers
- [ ] Network mirror protocol for `provider_installation` blocks (standard registry protocol endpoints exist, network mirror protocol has different URL patterns)

### 19.2 Provider Management
- [x] `POST /api/v2/organizations/:org/registry-providers` — add provider to private registry
- [x] `GET /api/v2/organizations/:org/registry-providers` — list providers
- [x] `GET /api/v2/registry-providers/:provider_id` — show provider
- [x] `DELETE /api/v2/registry-providers/:provider_id` — remove provider
- [x] `registry-name` field: `public` or `private`
- [x] `GET /api/v2/registry-providers/:provider_id/versions` — list provider versions
- [x] `POST /api/v2/registry-providers/:provider_id/versions` — create provider version
- [x] `DELETE /api/v2/registry-provider-versions/:version_id` — delete provider version
- [ ] GPG key management for provider signing

### 19.3 Provider Version Platforms
- [x] `GET /api/v2/registry-provider-versions/:version_id/platforms` — list platforms
- [x] `POST /api/v2/registry-provider-versions/:version_id/platforms` — add platform
- [x] `DELETE /api/v2/registry-provider-platforms/:platform_id` — remove platform
- [x] Platform: os (linux, darwin, windows), arch (amd64, arm64)
- [x] Protocol read endpoints work with stored platform data

---

## Epic 20: Health Assessments & Drift Detection

### 20.1 Health Assessments
- [x] `workspace.assessments-enabled` flag
- [ ] `organization.assessments-enforced` flag
- [ ] Scheduled health assessment runs
- [x] `assessment:drifted` notification trigger
- [x] `assessment:check_failure` notification trigger
- [x] `assessment:failed` notification trigger
- [ ] Health assessment results storage and API
- [ ] (Low priority for homelab MVP)

### 20.2 Continuous Validation
- [ ] Pre-apply check evaluation
- [ ] Check result storage
- [ ] (Low priority for homelab MVP)

---

## Epic 21: Data Retention & Garbage Collection

### 21.1 Data Retention Policies
- [ ] Organization-level data retention settings
- [x] Workspace-level data retention policies (override org)
- [x] State version retention count/duration (via `dataRetentionPolicies` table)
- [ ] Configuration version retention
- [ ] Run retention
- [ ] `backing_data_soft_deleted` state for state versions and CVs
- [ ] `backing_data_permanently_deleted` state
- [ ] GC scheduler
- [ ] Data restoration before permanent deletion

### 21.2 Retention Policy API
- [x] `GET /workspaces/:ws_id/relationships/data-retention-policy`
- [x] `POST /workspaces/:ws_id/relationships/data-retention-policy`
- [x] `DELETE /workspaces/:ws_id/relationships/data-retention-policy`
- [x] (Medium priority — important for long-running homelab)

---

## Epic 22: Tags (Key-Value Tag Bindings)

### 22.1 Tag Bindings API
- [x] `GET /workspaces/:ws_id/tag-bindings` — list workspace tags
- [x] `GET /workspaces/:ws_id/effective-tag-bindings` — list direct workspace tags
- [x] `PATCH /workspaces/:ws_id/tag-bindings` — add or update tags
- [x] Clear workspace tag bindings through workspace PATCH
- [x] `GET /projects/:proj_id/tag-bindings` — list project tags
- [x] `GET /projects/:proj_id/effective-tag-bindings` — list project tags
- [x] Filter workspaces by included/excluded tag keys and exact key-value bindings (on list endpoint)

### 22.2 Organization Tags & Tag Filtering
- [ ] Reserved tag key management
- [x] Tag-based workspace organization
- [x] Filter workspaces by included/excluded tag keys (`search[tags]`, `search[exclude-tags]`)
- [x] Filter workspaces by exact key-value tag bindings (`filter[tagged]`)

---

## Epic 23: No-Code Provisioning

### 23.1 No-Code Provisioning
- [ ] `POST /api/v2/organizations/:org/no-code-modules` — enable no-code on module version
- [ ] `GET /api/v2/organizations/:org/no-code-modules` — list no-code enabled modules
- [ ] `DELETE /api/v2/no-code-modules/:id` — disable no-code
- [ ] No-code workspace creation UI
- [ ] (Very low priority for homelab)

---

## Epic 24: Admin Operations (TFE-Specific)

### 24.1 Admin Users
- [x] `GET /api/v2/admin/users` — list all users
- [x] `GET /api/v2/admin/users/:user_id` — show user
- [x] `PATCH /api/v2/admin/users/:user_id` — update user (username, email)
- [x] `DELETE /api/v2/admin/users/:user_id` — suspend/delete user
- [x] `is-site-admin` attribute on user (first registered user is auto-promoted to site admin)
- [x] Site admin authorization guard on all admin endpoints (403 non-site-admins)

### 24.2 Admin Organizations
- [x] `GET /api/v2/admin/organizations` — list all orgs
- [x] `GET /api/v2/admin/organizations/:org_name` — show org
- [x] `PATCH /api/v2/admin/organizations/:org_name` — update org (name, email)
- [x] `DELETE /api/v2/admin/organizations/:org_name` — destroy org

### 24.3 Admin Workspaces
- [x] `GET /api/v2/admin/workspaces` — list all workspaces
- [x] `GET /api/v2/admin/workspaces/:ws_id` — show workspace
- [x] `PATCH /api/v2/admin/workspaces/:ws_id` — update workspace (name, version, locked)
- [x] `DELETE /api/v2/admin/workspaces/:ws_id` — delete workspace

### 24.4 Admin Runs
- [x] `GET /api/v2/admin/runs` — list all runs (with filters)
- [x] `GET /api/v2/admin/runs/:run_id` — show run
- [x] `POST /api/v2/admin/runs/:run_id/actions/cancel` — cancel any run
- [x] `POST /api/v2/admin/runs/:run_id/actions/force-cancel` — force cancel

### 24.5 Admin Terraform Versions
- [x] `GET /api/v2/admin/terraform-versions` — list available versions
- [x] `POST /api/v2/admin/terraform-versions` — add custom Terraform version
- [x] `PATCH /api/v2/admin/terraform-versions/:version_id` — update version
- [x] `DELETE /api/v2/admin/terraform-versions/:version_id` — remove version
- [x] `GET /api/v2/admin/terraform-versions/:version_id` — show version
- [x] Version attributes: version, url, sha, deprecated

### 24.6 Admin Sentinel Versions
- [x] `GET /api/v2/admin/sentinel-versions` — list versions
- [x] `POST /api/v2/admin/sentinel-versions` — add version
- [x] `GET /api/v2/admin/sentinel-versions/:id` — show version
- [x] `PATCH /api/v2/admin/sentinel-versions/:id` — update
- [x] `DELETE /api/v2/admin/sentinel-versions/:id` — remove

### 24.7 Admin OPA Versions
- [x] `GET /api/v2/admin/opa-versions` — list versions
- [x] `POST /api/v2/admin/opa-versions` — add version
- [x] `GET /api/v2/admin/opa-versions/:id` — show version
- [x] `PATCH /api/v2/admin/opa-versions/:id` — update
- [x] `DELETE /api/v2/admin/opa-versions/:id` — remove

### 24.8 Admin Settings
- [x] `GET /api/v2/admin/settings` — instance settings
- [x] `PATCH /api/v2/admin/settings` — update settings (stub)
- [x] Settings: cost-estimation enabled, sentinel enabled, etc.

### 24.9 Admin Module Registry Sharing
- [ ] `POST /api/v2/admin/module-sharing` — share modules across orgs
- [ ] `DELETE /api/v2/admin/module-sharing/:id` — stop sharing
- [ ] `GET /api/v2/admin/module-sharing` — list sharing configs

### 24.10 Admin Registry Sharing
- [ ] Registry mirror/proxy settings
- [ ] (Low priority)

### 24.11 Initial Admin User
- [ ] First-run setup wizard / initial admin creation
- [ ] Bootstrap process for fresh TFE instance
- [x] Browser first-run flow for local user registration and organization creation
- [ ] (Important for homelab — need admin bootstrap)

### 24.11 Audit Logs
- [x] `GET /api/v2/admin/audit-logs` — list all audit log entries (site admin)
- [x] `GET /organizations/:org_name/audit-logs` — list audit log entries for an org (owner)
- [x] `GET /api/v2/audit-trails` — audit trail endpoint (returns empty data array)
- [x] `GET /api/v2/organization-audit-trailers` — org audit trail endpoint (returns empty data array)
- [x] Audit log entries created automatically on user/org/workspace creation, run actions (apply, cancel, discard, force-cancel)

### 24.12 Support Bundles
- [ ] `POST /api/v1/support-bundle-requests` — generate support bundle
- [ ] `GET /api/v1/support-bundle-requests` — list bundles
- [ ] `GET /api/v1/support-bundle-requests/:id` — download bundle
- [ ] `DELETE /api/v1/support-bundle-requests/:id` — delete bundle
- [ ] (Low priority for homelab)

### 24.13 Usage Bundles
- [ ] `GET /api/v1/usage/bundle` — retrieve usage data
- [ ] (Very low priority for homelab)

### 24.14 Diagnostics
- [ ] `GET /api/v1/diagnostics` — comprehensive health diagnostics
- [ ] (Low priority)

---

## Epic 25: Stacks (HCP Terraform Only)

### 25.1 Stacks
- [ ] Stack CRUD API
- [ ] Stack deployments
- [ ] (TFE does NOT support Stacks — skip entirely)

---

## Epic 26: Change Requests

### 26.1 Change Requests
- [ ] `GET /workspaces/:ws_id/change-requests` — list change requests
- [ ] `POST /workspaces/:ws_id/change-requests` — create change request
- [ ] `GET /change-requests/:cr_id` — show change request
- [ ] `POST /change-requests/:cr_id/actions/approve` — approve
- [ ] `POST /change-requests/:cr_id/actions/discard` — discard
- [ ] (Very low priority for homelab)

---

## Epic 27: Frontend & User Interface

### 27.1 Core Views
- [x] Login view with username/password authentication
- [x] Organization dashboard with org listing
- [x] Workspace list with table (name, version, auto-apply, locked)
- [x] Workspace creation modal with engine selection
- [x] Workspace detail view with tabs
- [x] Variables management (add, delete, category, sensitive)
- [x] Run history list
- [x] Single run view (status tracker, log viewer, actions)
- [x] State history view (download, JSON viewer)

### 27.2 Workspace Detail Tabs
- [x] Overview tab (metadata cards)
- [x] Runs tab (run list with trigger button)
- [x] Variables tab
- [x] State Versions tab
- [x] Settings tab (auto-apply, engine, version)
- [x] Team Access tab
- [x] Notification Configurations tab
- [x] Policy Sets tab
- [x] SSH Key tab
- [x] VCS tab (connected repo info)
- [x] Health Assessments tab
- [x] Run Triggers tab
- [x] Organization settings page (general settings, team list, delete)

### 27.3 TFE UI Mirroring
- [x] Run timeline/progress indicator (state visualization)
- [x] Real-time log viewer (dark terminal output)
- [x] Consistent color scheme, typography, spacing
- [x] Responsive layout for desktop
- [x] Navigation breadcrumbs (Org > Workspace > Runs)
- [x] Organization settings page
- [x] Team management UI (create, invite, permissions)
- [ ] Project management UI (create, workspace assignment)
- [x] Variable Set CRUD, global scope, and workspace attachment UI
- [x] Variable Set variable editor UI
- [ ] VCS integration setup UI
- [ ] Agent pool management UI
- [x] Workspace lock/unlock UI indicators
- [x] Run detail with full state machine visualization
- [ ] Policy check results display
- [ ] Cost estimate display
- [ ] User profile / account settings page
- [ ] Admin dashboard (TFE instance management)
- [x] Search/filter workspaces
- [ ] Tag display and management in workspace list

### 27.4 Frontend Engineering
- [x] React Router with proper auth guards
- [x] `fetchApi` wrapper with token management
- [x] Automatic token refresh / expiry handling
- [x] Error boundary components
- [x] Loading states (skeletons, spinners)
- [x] Empty states (no organizations, no workspaces, etc.)
- [x] Toast/notification system for errors and success
- [x] Confirm dialogs for destructive actions
- [x] Shadcn UI components (button, card, table, dialog, input, checkbox)
- [x] Tailwind CSS for styling
- [x] API base URL configuration

---

## Epic 28: Execution Engine & Worker

### 28.1 Run Pipeline
- [x] Background worker queue (`startWorkerQueue`)
- [x] Run lifecycle: pending → planning → planned → applying → applied
- [x] Run lifecycle: pending → fetching → fetching_completed → queuing → plan_queued → planning → planned
- [x] Worker: temp directory creation per run
- [x] Worker: CV tar.gz extraction
- [x] Worker: path traversal guard
- [x] Worker: explicit workspace var-file and higher-precedence run `-var` injection
- [x] Worker: env var injection (env vars)
- [x] Worker: sanitized host environment
- [x] Worker: local backend override for uploaded `cloud` / remote backend configuration
- [x] Worker: `tofu init` / `terraform init`
- [x] Worker: `tofu plan -out=tfplan`
- [x] Worker: `tofu apply tfplan`
- [x] Worker: `terraform init` / `terraform plan` / `terraform apply`
- [x] Worker: `-target` support
- [x] Worker: `-replace` support
- [x] Worker: destroy mode (`-destroy`)
- [x] Worker: refresh-only mode
- [x] Worker: speculative/plan-only mode (no apply)
- [x] Worker: stdout/stderr streaming to logs
- [x] Worker: final status reporting (applied / errored)
- [x] Worker: temp directory cleanup
- [x] Worker: auto-apply check

### 28.2 Binary Version Management
- [x] Dynamic download of tofu/terraform binaries
- [x] SHA256 checksum verification
- [x] Binary caching by version
- [x] Exact-version requests fail closed instead of silently substituting another system version
- [x] Architecture detection (amd64/arm64)
- [x] OS detection (linux/macos)
- [x] Fallback to system binary
- [x] `latest` version resolution via API
- [x] Per-workspace binary selection (tofu vs terraform)
- [x] Native Terraform requests select Terraform for workspaces without an explicit binary
- [x] Per-workspace version selection
- [x] Organization-level default inheritance
- [x] Version constraint resolution (`~> 1.0.0`, `>= 1.2, < 2.0`) — resolves to highest matching release

### 28.4 Work Directory
- [x] `working-directory` support (execute in subdirectory)

### 28.5 Simulated Mode
- [x] `SIMULATED_RUNS=true` or `NODE_ENV=test` bypasses binary execution
- [x] Simulated plan/apply for testing

---

## Epic 29: Deployment & Operations

### 29.1 Container Build
- [x] Multi-stage Dockerfile
- [x] Bun + Vite build in builder stage
- [x] `TARGETARCH` build argument
- [x] Bundled tofu and terraform binaries with SHA verification
- [x] Production migration execution on container start
- [x] Unprivileged `appuser`
- [x] Persistent storage volume

### 29.2 Configuration
- [x] Environment variable configuration
- [x] `PORT` — HTTP port (default `3000`)
- [x] `DATABASE_URL` — SQLite path (default `file:./local.db`)
- [x] `STORAGE_DIR` — file storage path (default `./storage`)
- [x] `SIMULATED_RUNS` — bypass binary execution (default `false`)
- [x] `ALLOW_TOOL_FALLBACK` — cross-tool binary fallback (default `false`)
- [x] `ALLOW_UNVERIFIED_CHECKSUMS` — skip SHA256 verification (default `false`)
- [x] `CLI_TOKEN_TTL_MS` — native `terraform login` token TTL (default 30 days)
- [x] `PUBLIC_URL` — override for reverse-proxy upload/download/log URLs
- [x] `NODE_ENV` — environment mode (default `production`)
- [x] Database configuration (SQLite path, connection params)
- [x] Storage configuration (local path, future S3)
- [x] Instance metadata (version, build info)
- [x] `LOG_LEVEL` — logging verbosity (default `info`, supported levels: error/warn/info/debug)

### 29.3 Database
- [x] SQLite support (Drizzle ORM)
- [x] Migration execution on startup
- [x] WAL mode enabled
- [x] Foreign key enforcement

### 29.4 Storage Backend
- [x] Local filesystem for CV archives

### 29.5 Observability
- [x] Health check endpoint (`/healthz`, `/readyz`)
- [x] Request logging middleware (method, path, status, duration)
- [x] `LOG_LEVEL` environment variable consumed at runtime (error/warn/info/debug levels)
- [x] Structured JSON logging (structured JSON output via `log.info/warn/error/debug` helper)
- [ ] Prometheus metrics (Phase 2)

### 29.6 Security
- [x] Environment variable sanitization in worker
- [x] Path traversal protection on archive extraction
- [x] CORS configuration
- [x] API token storage as SHA-256 hash (backward compatible with existing plaintext tokens)

---

## Epic 30: Testing

### 30.1 Unit & Integration Tests
- [x] Service discovery test
- [x] Error handling tests (404 format, etc.)
- [x] User registration tests (create, duplicate, login)
- [x] Authentication tests (token creation, guards, org tokens)
- [x] Organization CRUD lifecycle tests
- [x] Workspace CRUD tests
- [x] Variable CRUD tests
- [x] Sensitive variable hiding test
- [x] Workspace tags CRUD tests (including delete)
- [x] Run creation test
- [x] Run apply → applied status test
- [x] Run cancel/discard/force-cancel test
- [x] State version CRUD tests
- [x] Configuration version upload test
- [x] Workspace lock/unlock test
- [x] Extended lifecycle tests (multi-step workflows)
- [x] Variable set CRUD tests
- [x] Team CRUD tests
- [x] Team membership tests
- [x] Team access to workspace tests
- [x] Project CRUD tests
- [x] OAuth client/token tests
- [x] Policy set tests
- [x] Notification configuration tests
- [x] SSH key CRUD tests
- [x] Module & Provider Registry tests
- [x] Admin Operations API tests
- [x] Workspace Run Triggers & Cost Estimate tests
- [x] Pagination contract tests (page-based queries, edge cases)
- [x] Organization contract tests (entitlements, permission checks)
- [x] Resource authorization tests (workspace isolation, cross-org access)
- [x] Run queue contract tests (serial execution, capacity limits)
- [x] Run state history tests (state version metadata, serial tracking)
- [x] Cloud contract tests (`cloud` backend compatibility)

### 30.2 Worker Tests
- [x] Worker queue processing test
- [x] Binary download and caching test
- [x] Variable injection correctness test
- [x] CV extraction and path traversal test
- [x] Log streaming test
- [x] State recording on apply test

### 30.3 Frontend Tests
- [x] Login flow test
- [x] Workspace creation flow
- [x] Variable management flow
- [x] Run workflow (create, view logs, apply)

### 30.4 Compatibility Tests
- [x] `terraform login` end-to-end flow
- [x] `cloud` backend block compatibility (Terraform CLI 1.1+)
- [x] `go-tfe` client library compatibility
- [x] `terrasnek` (Python) client compatibility

---

## Legend

- [x] **Done** — implemented and functional
- [ ] **Not started** — needs implementation
- [ ] (Marked with priority notes in parentheses for judgment calls)

Prioritization assumptions for homelab Docker deployment:

| Priority | Meaning                                                        |
| -------- | -------------------------------------------------------------- |
| **Core** | Needed for basic TFE API compatibility and `terraform login`   |
| **High** | Important for a useful self-hosted platform                    |
| **Med**  | Nice-to-have, fills feature gaps                               |
| **Low**  | Useful but non-critical for single-user/team homelab           |
| **Omit** | Enterprise-only features unlikely needed in homelab            |
