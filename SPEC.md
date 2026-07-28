# Terrence — Technical Specification

> **Project Goal:** A cleanroom, open-source, self-hosted reimplementation of Terraform Enterprise (TFE) packaged as a single Docker container, designed for homelab environments. The primary objective is wire-compatible API parity with TFE so that standard Terraform/OpenTofu CLI tools (`terraform login`, `cloud` backend block), the `go-tfe` library, and ecosystem tooling work without modification.
>
> **Design Philosophy:** Single-process, no external service dependencies (beyond SQLite), minimal operational burden, progressive enhancement toward full TFE feature parity. Homelab users should be able to `docker run` and have a working TFE-compatible endpoint.

---

## Table of Contents

1. [Architecture & Stack](#1-architecture--stack)
2. [API Compatibility Layer](#2-api-compatibility-layer)
3. [Core API Infrastructure](#3-core-api-infrastructure)
4. [Authentication & Authorization](#4-authentication--authorization)
5. [Organizations](#5-organizations)
6. [Users, Teams & Memberships](#6-users-teams--memberships)
7. [Projects](#7-projects)
8. [Workspaces](#8-workspaces)
9. [Variables & Variable Sets](#9-variables--variable-sets)
10. [State Management](#10-state-management)
11. [Configuration Versions](#11-configuration-versions)
12. [Runs, Plans & Applies](#12-runs-plans--applies)
13. [Policy as Code (Sentinel / OPA)](#13-policy-as-code-sentinel--opa)
14. [Cost Estimation](#14-cost-estimation)
15. [VCS Integrations](#15-vcs-integrations)
16. [SSH Keys](#16-ssh-keys)
17. [Notifications](#17-notifications)
18. [Agents](#18-agents)
19. [Run Tasks](#19-run-tasks)
20. [Private Registry — Modules](#20-private-registry--modules)
21. [Private Registry — Providers](#21-private-registry--providers)
22. [Health Assessments](#22-health-assessments)
23. [Data Retention & GC](#23-data-retention--gc)
24. [Tags (Key-Value Bindings)](#24-tags-key-value-bindings)
25. [Admin Operations](#25-admin-operations)
26. [Frontend](#26-frontend)
27. [Execution Engine & Worker](#27-execution-engine--worker)
28. [Deployment & Operations](#28-deployment--operations)
29. [Testing & Compatibility](#29-testing--compatibility)
30. [Reference Index](#30-reference-index)

---

## 1. Architecture & Stack

### 1.1 Runtime & Framework

| Component         | Choice         | Rationale                                                                              |
| ----------------- | -------------- | -------------------------------------------------------------------------------------- |
| Runtime           | Bun             | Fast JavaScript runtime with built-in test runner, bundler, and TypeScript support.    |
| Backend Framework | Elysia          | Type-safe, fast, excellent plugin system (auth, rate-limit, static file serving).      |
| Database ORM      | Drizzle ORM     | Type-safe SQL query builder with migration tooling.                                    |
| Database          | SQLite (Turso)  | Zero-config, file-based, ideal for homelab. Designed for future Postgres migration.    |
| Frontend          | React + Vite    | Standard modern SPA framework.                                                         |
| UI Library        | Tailwind + Shadcn | TFE-matching component library with consistent design system.                         |
| Frontend Build    | Vite            | Fast HMR, integrated with Bun.                                                         |

### 1.2 Process Model

```
┌──────────────────────────────────────────────────────┐
│                  Docker Container                     │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │              Bun Process                      │    │
│  │                                                │    │
│  │  ┌──────────────────┐  ┌──────────────────┐   │    │
│  │  │   Elysia HTTP    │  │  Background       │   │    │
│  │  │   Server (:3000) │  │  Worker Queue     │   │    │
│  │  │                  │  │  (startWorkerQueue)│   │    │
│  │  │  • API Routes    │  │                  │   │    │
│  │  │  • Auth Plugin   │  │  • executeRun()  │   │    │
│  │  │  • Static Files  │  │  • executeApply()│   │    │
│  │  │  • Rate Limit    │  │  • Binary Mgmt   │   │    │
│  │  └──────────────────┘  └──────────────────┘   │    │
│  │                                                │    │
│  │  ┌──────────────────────────────────────┐      │    │
│  │  │         SQLite Database              │      │    │
│  │  │  (users, orgs, workspaces, runs,     │      │    │
│  │  │   state, vars, logs, configs, etc.)  │      │    │
│  │  └──────────────────────────────────────┘      │    │
│  │                                                │    │
│  │  ┌──────────────────────────────────────┐      │    │
│  │  │         Storage (filesystem)         │      │    │
│  │  │  • CV tar.gz archives                │      │    │
│  │  │  • Downloaded tofu/terraform binaries│      │    │
│  │  └──────────────────────────────────────┘      │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

### 1.3 Execution Model

The worker queue runs in the same process as the HTTP server. Runs execute by spawning `tofu` or `terraform` as child processes (Bun.spawn). This avoids Docker-in-Docker complexity while providing full execution isolation through subprocess boundaries. A simulated execution mode (`SIMULATED_RUNS=true` or `NODE_ENV=test`) bypasses binary execution for testing.

**References:**
- TFE Remote Operations: `references/docs/enterprise/run/remote-operations.mdx`
- TFE Workspace Settings: `references/docs/enterprise/workspaces/settings/index.mdx`

---

## 2. API Compatibility Layer

### 2.1 API Versioning & Conventions

All V2 API endpoints use the prefix `/api/v2` as specified in the TFE API docs (`references/docs/enterprise/api-docs/index.mdx`). The API follows the [JSON API specification](https://jsonapi.org/).

**Required conventions:**
- Request Content-Type: `application/vnd.api+json`
- Response Content-Type: `application/vnd.api+json`
- Error format: `{ errors: [{ status: "...", title: "...", detail: "..." }] }`
- Return 404 for resources the user does not have access to (security through obscurity)
- Pagination via `page[number]` and `page[size]` query params
- Response includes `links` (self, first, prev, next, last) and `meta.pagination` when paginated
- Support `?include=related_resource` for embedding related resources

### 2.2 Service Discovery

- `GET /.well-known/terraform.json` — Returns `{ "tfe.v2.1": "/api/v2/", "tfe.v2.2": "/api/v2/", "state.v2": "/api/v2/", "modules.v1": "/api/registry/v1/" }`

**Reference:** TFE API docs: `references/docs/enterprise/api-docs/index.mdx`

### 2.3 Rate Limiting

- Default: 30 requests/second per user (not per token)
- Unauthenticated: per-IP rate limiting
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`
- 429 response on limit exceeded
- Per-endpoint lower limits for sensitive operations

**Reference:** TFE API docs section on Rate Limits: `references/docs/enterprise/api-docs/index.mdx`

### 2.4 System Endpoints

- `GET /api/v1/ping` — Returns `"pong"` (authenticated health check)
- `GET /api/v1/readiness` — Readiness probe
- `GET /api/v1/metadata` — Instance metadata (version, build info)

**Reference:** TFE System API: `references/docs/enterprise/api-docs/ping.mdx`

---

## 3. Core API Infrastructure

_Reference: TFE API docs index at `references/docs/enterprise/api-docs/index.mdx`_

### 3.1 Middleware Stack

1. **Rate Limiter** — `elysia-rate-limit` configured with per-user identity
2. **Auth Plugin** — Bearer token extraction, user/token/org identity derivation
3. **Body Parser** — JSON API document parsing for `application/vnd.api+json`
4. **Error Handler** — Uniform JSON API error responses
5. **Static Files** — Frontend SPA serving via `@elysiajs/static`
6. **CORS** — Cross-origin support for frontend development

### 3.2 Response Formatting

All responses must conform to the JSON API document structure:
```json
{
  "data": { "id": "...", "type": "...", "attributes": { ... }, "relationships": { ... } },
  "links": { "self": "..." },
  "meta": { "pagination": { "current-page": 1, "total-count": 42 } }
}
```

Error responses:
```json
{
  "errors": [{ "status": "404", "title": "Not Found", "detail": "Resource not found" }]
}
```

---

## 4. Authentication & Authorization

_Reference: TFE Account API at `references/docs/enterprise/api-docs/account.mdx`; TFE Users API at `references/docs/enterprise/api-docs/users.mdx`; TFE Team Tokens at `references/docs/enterprise/api-docs/team-tokens.mdx`_

### 4.1 User Registration & Login

**Phase 1 (MVP):**
- `POST /api/v2/users` — Register user (username, password)
- `POST /api/v2/users/login` — Authenticate, return bearer token
- Password stored as bcrypt hash
- 409 Conflict on duplicate username

**Phase 2:**
- Email field support
- Password validation (min 10 chars)
- Avatar URL generation (Gravatar)
- `is-service-account`, `auth-method` attributes

### 4.2 Bearer Token Authentication

**Token types:**
| Type | Creator | Permissions | Can plan/apply? |
|------|---------|-------------|-----------------|
| User | Individual user | As user's permissions | Yes |
| Organization | Org owner | Org-scoped management | No |
| Team | Team admin | Team-scoped | Yes |

**Token attributes:**
- `id`, `token` (secret, returned once), `description`, `created-at`, `last-used-at`, `expired-at`
- Token can have expiry date (ISO 8601 format)

**Endpoints:**
- `POST /api/v2/tokens` — Create token (user or org)
- `GET /users/:user_id/authentication-tokens` — List user tokens
- `GET /authentication-tokens/:id` — Show token metadata
- `DELETE /authentication-tokens/:id` — Revoke token
- `POST /teams/:team_id/authentication-tokens` — Create team token
- `GET /teams/:team_id/authentication-tokens` — List team tokens
- `GET /organizations/:org/authentication-token` — Get org token metadata
- `POST /organizations/:org/authentication-token` — Create org token
- `DELETE /organizations/:org/authentication-token` — Destroy org token

**Reference:** TFE Agent Tokens API: `references/docs/enterprise/api-docs/agent-tokens.mdx`; TFE Team Tokens: `references/docs/enterprise/api-docs/team-tokens.mdx`

### 4.3 Account Endpoint (terraform login support)

The `/api/v2/account/details` endpoint is required for `terraform login` token verification.

- `GET /api/v2/account/details` — Returns current identity (user, team, or org)
- `PATCH /api/v2/account/update` — Update username/email
- `PATCH /api/v2/account/password` — Change password
- `authenticated-resource` relationship for org/team tokens
- Permissions: `can-create-organizations`, `can-change-email`, `can-change-username`

**Reference:** TFE Account API: `references/docs/enterprise/api-docs/account.mdx`

### 4.4 Authorization Guards

**Permission levels:**
- **Organization**: Owner, member
- **Workspace**: read, plan, write, admin, custom (runs, variables, state-versions, locking, policy-overrides, run-tasks)
- **Team**: Organization-level (manage-policies, manage-workspaces, manage-vcs-settings, manage-agent-pools, manage-projects, etc.)

**Implementation:** Route guards via Elysia macros (`isAuth`, `checkOrgPermission`), with workspace-scoped permission checks derived from team-workspace access records.

**Reference:** TFE Team Access: `references/docs/enterprise/api-docs/team-access.mdx`; TFE Teams: `references/docs/enterprise/api-docs/teams.mdx`

---

## 5. Organizations

_Reference: TFE Organizations API at `references/docs/enterprise/api-docs/organizations.mdx`_

### 5.1 CRUD

| Method | Path | Action |
|--------|------|--------|
| GET | `/organizations` | List (paginated, searchable by `q`, `q[email]`, `q[name]`) |
| GET | `/organizations/:org_name` | Show details |
| POST | `/organizations` | Create |
| PATCH | `/organizations/:org_name` | Update |
| DELETE | `/organizations/:org_name` | Destroy with cascade |

### 5.2 Organization Attributes

```
{
  "external-id": "org-xxx",
  "created-at": "ISO8601",
  "email": "admin@homelab.local",
  "session-timeout": null,
  "session-remember": null,
  "collaborator-auth-policy": "password",
  "cost-estimation-enabled": false,
  "send-passing-statuses-for-untriggered-speculative-plans": false,
  "aggregated-commit-status-enabled": false,
  "speculative-plan-management-enabled": true,
  "allow-force-delete-workspaces": true,
  "name": "my-org",
  "permissions": { ... },
  "default-execution-mode": "remote",
  "user-tokens-enabled": true,
  "iac-binary": "tofu",
  "default-terraform-version": "latest"
}
```

### 5.3 Entitlements

- `GET /organizations/:org_name/entitlement-set` — Returns feature entitlements
- Entitlements: `operations`, `state-storage`, `teams`, `vcs-integrations`, `policy-enforcement`, `cost-estimation`, `private-module-registry`, `agents`, `run-tasks`, `sso`
- Feature gating: unentitled endpoints return 404

### 5.4 Relationships

- `oauth-tokens` → `/api/v2/organizations/:org/oauth-tokens`
- `authentication-token` → `/api/v2/organizations/:org/authentication-token`
- `entitlement-set` → `/api/v2/organizations/:org/entitlement-set`
- `default-agent-pool` — Agent pool relationship

---

## 6. Users, Teams & Memberships

_Reference: TFE Users API at `references/docs/enterprise/api-docs/users.mdx`; TFE Organization Memberships at `references/docs/enterprise/api-docs/organization-memberships.mdx`; TFE Teams at `references/docs/enterprise/api-docs/teams.mdx`; TFE Team Members at `references/docs/enterprise/api-docs/team-members.mdx`_

### 6.1 Users

| Method | Path | Action |
|--------|------|--------|
| GET | `/users/:user_id` | Show user (username, avatar, permissions) |
| POST | `/users` | Create user |
| GET | `/users` | List users (admin) |
| PATCH | `/users/:user_id` | Update user |
| DELETE | `/users/:user_id` | Delete user |

### 6.2 Organization Memberships

| Method | Path | Action |
|--------|------|--------|
| POST | `/organizations/:org/organization-memberships` | Invite user by email |
| GET | `/organizations/:org/organization-memberships` | List members |
| GET | `/organization-memberships/:id` | Show membership |
| DELETE | `/organization-memberships/:id` | Remove user |
| | | Status: `invited` → `active` |

### 6.3 Teams

| Method | Path | Action |
|--------|------|--------|
| GET | `/organizations/:org/teams` | List teams (search, pagination) |
| POST | `/organizations/:org/teams` | Create team |
| GET | `/teams/:team_id` | Show team |
| PATCH | `/teams/:team_id` | Update (name, visibility, org-access) |
| DELETE | `/teams/:team_id` | Destroy team |

**Team attributes:** `name`, `visibility` (secret/organization), `sso-team-id`, `users-count`, `organization-access` permissions object.

### 6.4 Team Membership

| Method | Path | Action |
|--------|------|--------|
| POST | `/teams/:team_id/relationships/users` | Add users by ID |
| POST | `/teams/:team_id/relationships/organization-memberships` | Add by membership ID |
| DELETE | `/teams/:team_id/relationships/users` | Remove users |

### 6.5 Team Access to Workspaces

| Method | Path | Action |
|--------|------|--------|
| GET | `/team-workspaces?filter[workspace][id]=:id` | List access |
| POST | `/team-workspaces` | Create access |
| PATCH | `/team-workspaces/:id` | Update access level |
| DELETE | `/team-workspaces/:id` | Remove access |

**Access levels:** `read`, `plan`, `write`, `admin`, `custom`
**Custom sub-permissions:** `runs`, `variables`, `state-versions`, `sentinel-mocks`, `workspace-locking`, `run-tasks`, `policy-overrides`

### 6.6 SSO / SCIM (Phase 2+)

SAML/SSO configuration endpoints, SCIM group mapping for teams, SCIM tokens. Low priority for homelab.

**Reference:** TFE SAML docs: `references/docs/enterprise/saml/`; TFE SCIM docs: `references/docs/enterprise/scim/`

---

## 7. Projects

_Reference: TFE Projects API at `references/docs/enterprise/api-docs/projects.mdx`; TFE Projects docs at `references/docs/enterprise/projects/`_

### 7.1 CRUD

| Method | Path | Action |
|--------|------|--------|
| GET | `/organizations/:org/projects` | List projects |
| POST | `/organizations/:org/projects` | Create project |
| GET | `/projects/:project_id` | Show project |
| PATCH | `/projects/:project_id` | Update project |
| DELETE | `/projects/:project_id` | Delete project (must be empty) |

### 7.2 Project Attributes

```json
{
  "name": "Production",
  "description": "Production infrastructure",
  "default-execution-mode": "remote",
  "setting-overwrites": { "execution-mode": false },
  "auto-destroy-activity-duration": null
}
```

### 7.3 Tag Bindings

- `GET /projects/:project_id/tag-bindings`
- `GET /projects/:project_id/effective-tag-bindings`
- `POST /projects/:project_id/tag-bindings`
- `DELETE /projects/:project_id/tag-bindings`

### 7.4 Workspace Assignment

- `data.relationships.project.data.id` on workspace create and update
- Default project created per-organization
- Project-level execution mode default inheritance

---

## 8. Workspaces

_Reference: TFE Workspaces API at `references/docs/enterprise/api-docs/workspaces.mdx`; TFE Workspace Settings at `references/docs/enterprise/workspaces/settings/index.mdx`_

### 8.1 Full CRUD

| Method | Path | Action |
|--------|------|--------|
| POST | `/organizations/:org/workspaces` | Create workspace |
| GET | `/organizations/:org/workspaces` | List workspaces (paginated, filterable) |
| GET | `/organizations/:org/workspaces/:name` | Show by org+name |
| GET | `/workspaces/:workspace_id` | Show by ID |
| PATCH | `/workspaces/:workspace_id` | Update by ID |
| PATCH | `/organizations/:org/workspaces/:name` | Update by name |
| DELETE | `/workspaces/:workspace_id` | Force delete |
| DELETE | `/organizations/:org/workspaces/:name` | Force delete by name |
| POST | `/organizations/:org/workspaces/:name/actions/safe-delete` | Safe delete |
| POST | `/workspaces/:id/actions/safe-delete` | Safe delete by ID |

### 8.2 Workspace Attributes

**Core (Phase 1):**
| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique within org |
| `description` | string | Optional description |
| `auto-apply` | bool | Auto-apply on successful plan |
| `terraform-version` | string | Version or constraint |
| `working-directory` | string | Terraform execution subdirectory |
| `execution-mode` | enum | `remote`, `local`, `agent` |
| `iac-binary` | string | `tofu` or `terraform` (custom extension) |

**VCS (Phase 2):**
| Attribute | Type | Description |
|-----------|------|-------------|
| `vcs-repo.branch` | string | VCS branch |
| `vcs-repo.identifier` | string | `:org/:repo` format |
| `vcs-repo.oauth-token-id` | string | OAuth token reference |
| `vcs-repo.ingress-submodules` | bool | Fetch submodules |
| `vcs-repo.tags-regex` | string | Git tag trigger regex |
| `file-triggers-enabled` | bool | Filter by changed files |
| `trigger-prefixes` | string[] | Path prefixes for VCS monitoring |
| `trigger-patterns` | string[] | Glob patterns for VCS monitoring |

**Advanced (Phase 2+):**
| Attribute | Type | Description |
|-----------|------|-------------|
| `queue-all-runs` | bool | Queue runs immediately on creation |
| `speculative-enabled` | bool | Allow speculative plans on PRs |
| `allow-destroy-plan` | bool | Allow destroy plans |
| `global-remote-state` | bool | Share state with all org workspaces |
| `project-remote-state` | bool | Share state within project |
| `agent-pool-id` | string | Agent pool for agent execution |
| `assessments-enabled` | bool | Health assessments (drift detection) |
| `auto-destroy-at` | string | Scheduled destroy timestamp |
| `auto-destroy-activity-duration` | string | Inactivity-based auto-destroy |
| `auto-apply-run-trigger` | bool | Separate auto-apply for run triggers |
| `source-name` | string | Friendly client identification |
| `source-url` | string | Client URL |
| `setting-overwrites` | object | Override project defaults |

### 8.3 Lock / Unlock / Force-Unlock

| Method | Path |
|--------|------|
| POST | `/workspaces/:id/actions/lock` |
| POST | `/workspaces/:id/actions/unlock` |
| POST | `/workspaces/:id/actions/force-unlock` |

Lock reason tracking via `locked-reason` attribute.

### 8.4 Tags (Flat String Tags)

| Method | Path | Action |
|--------|------|--------|
| GET | `/workspaces/:id/relationships/tags` | List tags |
| POST | `/workspaces/:id/relationships/tags` | Add tags |
| DELETE | `/workspaces/:id/relationships/tags` | Remove tags |

### 8.5 Tags (Key-Value Tag Bindings)

| Method | Path | Action |
|--------|------|--------|
| GET | `/workspaces/:id/tag-bindings` | List direct tags |
| GET | `/workspaces/:id/effective-tag-bindings` | Direct + inherited from project |
| POST | `/workspaces/:id/tag-bindings` | Add tag bindings |
| DELETE | `/workspaces/:id/tag-bindings` | Remove tag bindings |
| POST | `/organizations/:org/workspaces` | Create with tag-bindings relationship |

**Reference:** TFE Workspace Tags: `references/docs/enterprise/workspaces/tags.mdx`; TFE Organization Tags: `references/docs/enterprise/api-docs/organization-tags.mdx`

### 8.6 Remote State Consumers

| Method | Path | Action |
|--------|------|--------|
| GET | `/workspaces/:id/relationships/remote-state-consumers` | List consumers |
| POST | `/workspaces/:id/relationships/remote-state-consumers` | Add consumers |
| PATCH | `/workspaces/:id/relationships/remote-state-consumers` | Replace consumers |
| DELETE | `/workspaces/:id/relationships/remote-state-consumers` | Remove consumers |

Also controlled via `global-remote-state` and `project-remote-state` boolean flags.

**Reference:** TFE State: `references/docs/enterprise/workspaces/state.mdx`

### 8.7 SSH Key Assignment

| Method | Path | Action |
|--------|------|--------|
| PATCH | `/workspaces/:id/relationships/ssh-key` | Assign SSH key |
| PATCH | `/workspaces/:id/relationships/ssh-key` (null data) | Unassign |

### 8.8 Data Retention Policy

| Method | Path | Action |
|--------|------|--------|
| GET | `/workspaces/:id/relationships/data-retention-policy` | Show |
| POST | `/workspaces/:id/relationships/data-retention-policy` | Create/update |
| DELETE | `/workspaces/:id/relationships/data-retention-policy` | Remove |

### 8.9 Run History

- `GET /workspaces/:id/runs` — List runs with rich filtering
- Filters: `filter[operation]`, `filter[status]`, `filter[source]`, `filter[status_group]`, `filter[timeframe]`, `filter[agent_pool_names]`
- Search: `search[user]`, `search[commit]`, `search[basic]`

---

## 9. Variables & Variable Sets

_Reference: TFE Variables API at `references/docs/enterprise/api-docs/variables.mdx`; TFE Variable Sets at `references/docs/enterprise/api-docs/variable-sets.mdx`; TFE Workspace Variables at `references/docs/enterprise/api-docs/workspace-variables.mdx`; TFE Managing Variables at `references/docs/enterprise/variables/managing-variables.mdx`_

### 9.1 Workspace-Scoped Variables

| Method | Path | Action |
|--------|------|--------|
| GET | `/workspaces/:id/vars` | List variables |
| POST | `/workspaces/:id/vars` | Create variable |
| GET | `/workspaces/:id/vars/:var_id` | Get variable |
| PATCH | `/workspaces/:id/vars/:var_id` | Update variable |
| DELETE | `/workspaces/:id/vars/:var_id` | Delete variable |

**Variable attributes:**
| Attribute | Type | Description |
|-----------|------|-------------|
| `key` | string | Variable name |
| `value` | string | Variable value (null if sensitive) |
| `category` | enum | `terraform` or `env` |
| `hcl` | bool | Evaluate value as HCL |
| `sensitive` | bool | Hide value in responses |
| `description` | string | Optional description |

### 9.2 Deprecated Global `/vars` API

The global `/api/v2/vars` endpoint is deprecated in TFE. Implement for backward compatibility with old tooling, but prefer workspace-scoped vars.

### 9.3 Variable Sets

| Method | Path | Action |
|--------|------|--------|
| GET | `/organizations/:org/varsets` | List variable sets |
| POST | `/organizations/:org/varsets` | Create variable set |
| GET | `/varsets/:varset_id` | Show variable set |
| PATCH | `/varsets/:varset_id` | Update variable set |
| DELETE | `/varsets/:varset_id` | Delete variable set |
| POST | `/varsets/:id/relationships/workspaces` | Attach to workspaces |
| DELETE | `/varsets/:id/relationships/workspaces` | Detach from workspaces |
| POST | `/varsets/:id/relationships/projects` | Attach to projects |
| DELETE | `/varsets/:id/relationships/projects` | Detach from projects |
| POST | `/varsets/:id/relationships/vars` | Add variables to set |
| PATCH | `/varsets/:id/relationships/vars` | Update variables in set |
| DELETE | `/varsets/:id/relationships/vars` | Remove variables |

**Variable Set attributes:** `name`, `description`, `global` (apply to all workspaces), `priority` (override command-line values), `parent` (organization or project owner)

### 9.4 Variable Precedence

```
Run-specific variables > Workspace variables > Variable sets > Project default
Priority variable sets > Regular variable sets > CLI `-var` flags
```

---

## 10. State Management

_Reference: TFE State Versions API at `references/docs/enterprise/api-docs/state-versions.mdx`; TFE State Version Outputs at `references/docs/enterprise/api-docs/state-version-outputs.mdx`; TFE Workspace State at `references/docs/enterprise/workspaces/state.mdx`_

### 10.1 State Versions

| Method | Path | Action |
|--------|------|--------|
| POST | `/workspaces/:id/state-versions` | Create state version |
| GET | `/workspaces/:id/current-state-version` | Get current state |
| GET | `/state-versions/:sv_id` | Show state version |
| GET | `/workspaces/:id/state-versions` | List state versions (paginated) |
| GET | `/state-versions/:sv_id/download` | Download state payload |
| DELETE | `/state-versions/:sv_id` | Delete state version |
| GET | `/state-versions/:sv_id/state-version-outputs` | List state outputs |

### 10.2 State Version Attributes

```json
{
  "serial": 1,
  "md5": "d41d8cd98f00b204e9800998ecf8427e",
  "lineage": "871d1b4a-e579-fb7c-ffdb-f0c858a647a7",
  "state": "base64-encoded-raw-state",
  "json-state": "base64-encoded-json-state",
  "json-state-outputs": "base64-encoded-outputs",
  "status": "finalized",
  "terraform-version": "1.6.0",
  "resources-processed": true,
  "resources": [ ... ],
  "modules": [ ... ],
  "providers": [ ... ],
  "vcs-commit-sha": null,
  "vcs-commit-url": null,
  "hosted-state-download-url": "signed-url",
  "hosted-json-state-download-url": "signed-url",
  "run": { "data": { "id": "run-xxx", "type": "runs" } }
}
```

**State version statuses:** `pending` → `finalized` | `discarded` → `backing_data_soft_deleted` → `backing_data_permanently_deleted`

### 10.3 Upload & Download Pattern

TFE uses a blob storage pattern with signed URLs for state uploads and downloads. Terrence initially provides direct download via `/api/v2/state-versions/:sv_id/download` and direct state in responses. Future enhancement: implement signed temporal URL pattern.

### 10.4 State Version Outputs

- `GET /state-versions/:sv_id/state-version-outputs` — List outputs
- Each output has: `name`, `value`, `sensitive`, `type`

---

## 11. Configuration Versions

_Reference: TFE Configuration Versions API at `references/docs/enterprise/api-docs/configuration-versions.mdx`_

### 11.1 CRUD

| Method | Path | Action |
|--------|------|--------|
| POST | `/workspaces/:id/configuration-versions` | Create CV (returns upload URL) |
| GET | `/workspaces/:id/configuration-versions` | List CVs (paginated) |
| GET | `/configuration-versions/:cv_id` | Show CV |
| PUT | `/configuration-versions/:cv_id/upload` | Upload tar.gz |
| GET | `/configuration-versions/:cv_id/download` | Download tar.gz |
| GET | `/configuration-versions/:cv_id/ingress-attributes` | VCS commit info |

### 11.2 CV Attributes

```json
{
  "status": "uploaded",
  "speculative": false,
  "provisional": false,
  "source": "tfe-api",
  "status-timestamps": { "uploaded-at": "...", "archived-at": "..." },
  "error": null,
  "error-message": null
}
```

### 11.3 CV States

`pending` → `fetching` (VCS) / `uploaded` (API) → `archived` → `backing_data_soft_deleted` → `backing_data_permanently_deleted`

Optionally `errored` from any non-terminal state.

### 11.4 Ingress Attributes (VCS)

```
commit-sha, commit-url, commit-message, branch, tag,
pull-request-number, sender-username, clone-url, compare-url
```

---

## 12. Runs, Plans & Applies

_Reference: TFE Runs API at `references/docs/enterprise/api-docs/run.mdx`; TFE Plans API at `references/docs/enterprise/api-docs/plans.mdx`; TFE Applies API at `references/docs/enterprise/api-docs/applies.mdx`; TFE Run Modes at `references/docs/enterprise/run/modes-and-options.mdx`_

### 12.1 Run CRUD

| Method | Path | Action |
|--------|------|--------|
| POST | `/runs` | Create run |
| GET | `/runs/:run_id` | Show run details |
| GET | `/workspaces/:id/runs` | List runs in workspace |
| GET | `/organizations/:org/runs` | List runs in organization |
| DELETE | `/runs/:run_id` | Delete run |

### 12.2 Run Actions

| Method | Path | Action |
|--------|------|--------|
| POST | `/runs/:id/actions/apply` | Confirm and queue apply |
| POST | `/runs/:id/actions/discard` | Discard run |
| POST | `/runs/:id/actions/cancel` | Cancel run |
| POST | `/runs/:id/actions/force-cancel` | Force cancel run |
| POST | `/runs/:id/comments` | Add comment to run |

### 12.3 Run State Machine (Complete)

```
pending
  → fetching → fetching_completed
  → pre_plan_running → pre_plan_completed
  → queuing → plan_queued
  → planning
  → planned
    → cost_estimating → cost_estimated
    → policy_checking → policy_override/policy_soft_failed/policy_checked
    → confirmed
    → post_plan_running → post_plan_completed
    → planned_and_finished [terminal — no changes/plan-only]
    → planned_and_saved [awaiting apply confirmation]
  → apply_queued
  → applying
  → applied [terminal]
  → discarded [terminal]
  → canceled [terminal]
  → force_canceled [terminal]
  → errored [terminal]
  → unreachable [terminal — agent]
```

**Phase 1 implements:** `pending` → `planning` → `planned` → `applying` → `applied` | `errored` | `discarded` | `canceled`
**Phase 2 adds:** Full state machine with all intermediate states and policy/cost estimation stages.

### 12.4 Run Attributes

```json
{
  "actions": {
    "is-cancelable": true,
    "is-confirmable": false,
    "is-discardable": false,
    "is-force-cancelable": false
  },
  "has-changes": false,
  "auto-apply": false,
  "allow-empty-apply": false,
  "allow-config-generation": false,
  "is-destroy": false,
  "message": "Queued manually via the API",
  "plan-only": false,
  "refresh": true,
  "refresh-only": false,
  "save-plan": false,
  "source": "tfe-api",
  "trigger-reason": "manual",
  "status-timestamps": { "plan-queueable-at": "...", "planned-at": "..." },
  "target-addrs": null,
  "replace-addrs": null,
  "variables": [],
  "permissions": {
    "can-apply": true, "can-cancel": true, "can-discard": true,
    "can-force-cancel": true, "can-force-execute": true,
    "can-override-policy-check": true, "can-comment": true
  }
}
```

### 12.5 Run Modes

| Mode | Attribute | Description |
|------|-----------|-------------|
| Standard plan & apply | (default) | Full lifecycle |
| Plan-only / speculative | `plan-only: true` | No apply phase |
| Destroy | `is-destroy: true` | Destroys all resources |
| Refresh-only | `refresh-only: true` | State refresh only |
| Empty apply | `allow-empty-apply: true` | Apply with no changes (state upgrade) |
| Saved plan | `save-plan: true` | Plan without becoming current run |
| Debug | `debugging-mode: true` | `TF_LOG=TRACE` equivalent |

### 12.6 Plans

| Method | Path | Action |
|--------|------|--------|
| GET | `/plans/:plan_id` | Show plan details |
| GET | `/runs/:id/plan` | Plan relationship from run |
| GET | `/plans/:plan_id/json-output` | JSON plan output |

**Plan attributes:** `has-changes`, `resource-additions`, `resource-changes`, `resource-destructions`, `resource-imports`, `generated-configuration`, `execution-details` (mode, agent info), `status-timestamps`, `log-read-url`

### 12.7 Applies

| Method | Path | Action |
|--------|------|--------|
| GET | `/applies/:apply_id` | Show apply details |

**Apply attributes:** Same resource counts as plan, `status-timestamps`, `log-read-url`, `state-versions` relationship

### 12.8 Run Logs

| Method | Path | Action |
|--------|------|--------|
| GET | `/runs/:id/plan/log` | Plain-text plan log |
| GET | `/runs/:id/apply/log` | Plain-text apply log |
| GET | `/runs/:id/logs` | Structured JSON logs |

Logs stored with `(run_id, phase)` composite index for fast lookup. Streamed from subprocess stdout/stderr concurrently.

### 12.9 Run Queue

- Per-workspace serial queue (one run at a time)
- Pending runs wait for current run to complete
- Speculative/plan-only runs do NOT block the queue
- Locked workspace: runs can be created but won't start executing
- Worker polls every 1.5s for pending runs

### 12.10 Run-Specific Variables

Runs can carry per-run variables that take highest precedence:
```json
"variables": [{ "key": "replicas", "value": "2" }]
```

---

## 13. Policy as Code (Sentinel / OPA)

_Reference: TFE Policy Sets API at `references/docs/enterprise/api-docs/policy-sets.mdx`; TFE Policy Checks API at `references/docs/enterprise/api-docs/policy-checks.mdx`; TFE Policies API at `references/docs/enterprise/api-docs/policies.mdx`; TFE Policy Set Params at `references/docs/enterprise/api-docs/policy-set-params.mdx`; TFE Policy Enforcement at `references/docs/enterprise/policy-enforcement/`_

### 13.1 Policy Sets

| Method | Path | Action |
|--------|------|--------|
| GET | `/organizations/:org/policy-sets` | List |
| POST | `/organizations/:org/policy-sets` | Create |
| GET | `/policy-sets/:id` | Show |
| PATCH | `/policy-sets/:id` | Update |
| DELETE | `/policy-sets/:id` | Delete |
| POST | `/policy-sets/:id/relationships/workspaces` | Attach |
| DELETE | `/policy-sets/:id/relationships/workspaces` | Detach |
| POST | `/policy-sets/:id/relationships/projects` | Attach to projects |
| DELETE | `/policy-sets/:id/relationships/projects` | Detach |
| POST | `/policy-sets/:id/relationships/workspace-exclusions` | Exclude workspaces |
| POST | `/policy-sets/:id/versions` | Upload policy set version |

**Attributes:** `name`, `description`, `global`, `kind` (sentinel|opa), `overridable`, `agent-enabled`, `policy-tool-version`, `vcs-repo`, `policies-path`, `policy-update-patterns`

### 13.2 Individual Policies

| Method | Path | Action |
|--------|------|--------|
| GET | `/policy-sets/:id/policies` | List policies in set |
| GET | `/policies/:policy_id` | Show policy |
| POST | `/policy-sets/:id/policies` | Upload policy |
| PATCH | `/policies/:id` | Update |
| DELETE | `/policies/:id` | Delete |

**Enforcement levels:** `hard-mandatory`, `soft-mandatory`, `advisory`

### 13.3 Policy Checks

| Method | Path | Action |
|--------|------|--------|
| GET | `/runs/:id/policy-checks` | List checks for a run |
| GET | `/policy-checks/:check_id` | Show check result |
| POST | `/policy-checks/:check_id/actions/override` | Override soft-fail policy |

**Check states:** `pending`, `running`, `passed`, `failed`, `overridden`, `soft_failed`, `canceled`, `errored`

### 13.4 OPA Integration

- OPA tool version management
- Run `opa eval` against plan JSON output
- Parse OPA result format (pass/fail, individual rule results)

### 13.5 Policy Enforcement in Pipeline

```
Plan → Cost Estimate → Policy Check → Apply
                              ↓
              ┌───────────────┴───────────────┐
              ↓                               ↓
         Hard-fail:                     Soft-fail:
         blocks apply              requires override
              ↓                               ↓
         [errored]           ┌────────────────┴────────────┐
                             ↓                             ↓
                        override                     discarding
                             ↓                             ↓
                        proceeds                    [discarded]
```

---

## 14. Cost Estimation

_Reference: TFE Cost Estimates API at `references/docs/enterprise/api-docs/cost-estimates.mdx`; TFE Cost Estimation docs at `references/docs/enterprise/cost-estimation/`_

### 14.1 Cost Estimate API

| Method | Path | Action |
|--------|------|--------|
| GET | `/cost-estimates/:ce_id` | Show cost estimate |

### 14.2 Pipeline Integration

Cost estimation runs after plan and before policy check. For homelab MVP, cost estimation can be stubbed/simulated (no cloud pricing data required). Cost estimate found via `relationships.cost-estimate` on run object.

### 14.3 Attributes

```json
{
  "status": "finished",
  "prior-monthly-cost": "0.0",
  "proposed-monthly-cost": "125.50",
  "delta-monthly-cost": "125.50",
  "resources-count": 4,
  "matched-resources-count": 3,
  "unmatched-resources-count": 1,
  "error-message": null
}
```

**Phase 1:** Stub/simulated — return zero costs.
**Phase 2:** Real cost estimation via Infracost or similar engine integration (low priority).

---

## 15. VCS Integrations

_Reference: TFE OAuth Clients API at `references/docs/enterprise/api-docs/oauth-clients.mdx`; TFE OAuth Tokens at `references/docs/enterprise/api-docs/oauth-tokens.mdx`; TFE VCS docs at `references/docs/enterprise/vcs/`_

### 15.1 OAuth Clients

| Method | Path | Action |
|--------|------|--------|
| GET | `/organizations/:org/oauth-clients` | List OAuth clients |
| POST | `/organizations/:org/oauth-clients` | Create OAuth client |
| GET | `/oauth-clients/:id` | Show |
| PATCH | `/oauth-clients/:id` | Update |
| DELETE | `/oauth-clients/:id` | Delete |

**Service providers:** `github`, `gitlab`, `bitbucket`, `github_enterprise`, `gitlab_ce`, `gitlab_ee`, `azure_devops_server`, `bitbucket_data_center`

**Attributes:** `api-url`, `http-url`, `key`, `secret`, `callback-url`, `connect-path`, `rsa-public-key`, `service-provider`, `service-provider-display-name`

### 15.2 OAuth Tokens

| Method | Path | Action |
|--------|------|--------|
| GET | `/oauth-clients/:id/oauth-tokens` | List tokens |
| GET | `/oauth-tokens/:id` | Show |
| DELETE | `/oauth-tokens/:id` | Revoke |

**Attributes:** `service-provider-user`, `has-ssh-key`

### 15.3 GitHub App Installations

| Method | Path | Action |
|--------|------|--------|
| GET | `/organizations/:org/github-app-installations` | List installations |

### 15.4 Webhook Handling

| Endpoint | Event Source |
|----------|-------------|
| `POST /api/webhooks/github` | GitHub push, PR, tag events |
| `POST /api/webhooks/gitlab` | GitLab push, MR, tag events |
| `POST /api/webhooks/bitbucket` | Bitbucket push, PR events |

**Workflow:**
1. Receive webhook → validate payload signature
2. Parse event type (push, PR open, PR sync, tag)
3. Find linked workspaces (by VCS repo identifier + branch)
4. Create configuration version (fetch from VCS)
5. Queue run (plan-only for PR, full run for push)
6. Report commit status back to VCS (pending → success/failure)

**Trigger filtering:**
- `trigger-prefixes` / `trigger-patterns` / `working-directory` filter which file changes trigger runs
- `tags-regex` for Git tag-triggered runs

**Reference:** TFE VCS Events: `references/docs/enterprise/api-docs/vcs-events.mdx`

### 15.5 Commit Status Reporting

- Report plan status back to VCS via Status API / Commit Status API
- Status: `pending` (planning), `success` (planned/applied), `failure` (errored)
- `aggregated-commit-status-enabled` org-level flag
- `send-passing-statuses-for-untriggered-speculative-plans` flag

---

## 16. SSH Keys

_Reference: TFE SSH Keys API at `references/docs/enterprise/api-docs/ssh-keys.mdx`_

### 16.1 SSH Key CRUD

| Method | Path | Action |
|--------|------|--------|
| GET | `/organizations/:org/ssh-keys` | List SSH keys |
| POST | `/organizations/:org/ssh-keys` | Create SSH key |
| GET | `/ssh-keys/:id` | Show SSH key (metadata only) |
| PATCH | `/ssh-keys/:id` | Update SSH key |
| DELETE | `/ssh-keys/:id` | Delete SSH key |

- Private key is write-only (never returned in API responses)
- Keys stored encrypted at rest

### 16.2 SSH Key Assignment

- Assign to VCS OAuth token (for repo clone access via SSH)
- Assign to workspace (for Git-based module sources)

---

## 17. Notifications

_Reference: TFE Notification Configurations API at `references/docs/enterprise/api-docs/notification-configurations.mdx`; TFE notification configuration sub-docs at `references/docs/enterprise/api-docs/notification-configurations/`_

### 17.1 Workspace Notification Configurations

| Method | Path | Action |
|--------|------|--------|
| GET | `/workspaces/:id/notification-configurations` | List |
| POST | `/workspaces/:id/notification-configurations` | Create |
| GET | `/notification-configurations/:id` | Show |
| PATCH | `/notification-configurations/:id` | Update |
| DELETE | `/notification-configurations/:id` | Delete |
| POST | `/notification-configurations/:id/actions/verify` | Test notification |

**Attributes:** `destination-type` (generic|slack|microsoft-teams), `url`, `enabled`, `triggers` array

**Triggers:**
| Trigger | Description |
|---------|-------------|
| `run:created` | Run enters pending |
| `run:planning` | Run starts planning |
| `run:needs_attention` | Plan has changes, needs approval |
| `run:applying` | Run started apply |
| `run:completed` | Run completed successfully |
| `run:errored` | Run errored or canceled |
| `assessment:drifted` | Drift detected |
| `assessment:check_failure` | Continuous validation failed |
| `assessment:failed` | Health assessment failed |
| `workspace:auto_destroy_reminder` | Auto-destroy imminent |
| `workspace:auto_destroy_run_results` | Auto-destroy completed |

### 17.2 Team Notification Configurations

- `POST /teams/:team_id/notification-configurations`
- Trigger: `team:change_request`

### 17.3 Notification Delivery

HTTP POST to destination URL with standardized payload:
```json
{
  "payload_version": 1,
  "notification_configuration_id": "nc-xxx",
  "run_url": "https://...",
  "run_id": "run-xxx",
  "workspace_name": "my-ws",
  "organization_name": "my-org",
  "notifications": [{ "trigger": "run:completed", "run_status": "applied", ... }]
}
```

---

## 18. Agents

_Reference: TFE Agents API at `references/docs/enterprise/api-docs/agents.mdx`; TFE Agent Tokens at `references/docs/enterprise/api-docs/agent-tokens.mdx`; TFE Application Admin Agents at `references/docs/enterprise/application-administration/agents-on-tfe.mdx`_

### 18.1 Agent Pools

| Method | Path | Action |
|--------|------|--------|
| GET | `/organizations/:org/agent-pools` | List (searchable, paginated) |
| POST | `/organizations/:org/agent-pools` | Create |
| GET | `/agent-pools/:id` | Show |
| PATCH | `/agent-pools/:id` | Update |
| DELETE | `/agent-pools/:id` | Delete |

**Attributes:** `name`, `organization-scoped`, `agent-count`
**Relationships:** `workspaces`, `allowed-workspaces`, `allowed-projects`, `authentication-tokens`

### 18.2 Agent Tokens

| Method | Path | Action |
|--------|------|--------|
| GET | `/agent-pools/:id/authentication-tokens` | List tokens |
| POST | `/agent-pools/:id/authentication-tokens` | Create token |
| GET | `/authentication-tokens/:id` | Show |
| DELETE | `/authentication-tokens/:id` | Delete |

### 18.3 Agents

| Method | Path | Action |
|--------|------|--------|
| GET | `/agent-pools/:id/agents` | List agents |
| GET | `/agents/:id` | Show agent |
| DELETE | `/agents/:id` | Delete agent |

**Agent states:** `idle`, `busy`, `exited`, `errored`, `unknown`

### 18.4 Agent Execution Mode

Workspaces can use `execution-mode: agent` with `agent-pool-id`. Runs are dispatched to an agent in the pool for execution rather than running in-process. For homelab, this is low priority since the built-in worker handles local execution.

---

## 19. Run Tasks

_Reference: TFE Run Tasks API at `references/docs/enterprise/api-docs/run-tasks/`_

### 19.1 Run Task CRUD

| Method | Path | Action |
|--------|------|--------|
| GET | `/organizations/:org/run-tasks` | List |
| POST | `/organizations/:org/run-tasks` | Create |
| GET | `/run-tasks/:id` | Show |
| PATCH | `/run-tasks/:id` | Update |
| DELETE | `/run-tasks/:id` | Delete |

### 19.2 Run Task Execution

- Attach to workspaces: `POST /workspaces/:id/run-tasks`
- Detach: `DELETE /workspaces/:id/run-tasks/:task_id`
- Run tasks execute at pre-plan and post-plan stages
- HMAC-signed payloads for callback verification
- Results: `GET /runs/:id/run-tasks`, `GET /run-tasks/:id/task-results`

**Low priority for homelab** — skip for MVP.

---

## 20. Private Registry — Modules

_Reference: TFE Private Registry Modules API at `references/docs/enterprise/api-docs/private-registry/modules.mdx`; TFE Private Registry Manage Module Versions at `references/docs/enterprise/api-docs/private-registry/manage-module-versions.mdx`; TFE Registry docs at `references/docs/enterprise/registry/`_

### 20.1 Standard Registry Protocol

The module registry implements the [Terraform Registry HTTP API](https://developer.hashicorp.com/terraform/registry/api-docs) for consuming modules:

| Endpoint | Description |
|----------|-------------|
| `GET /api/registry/v1/modules/:namespace/:name/:provider/versions` | List versions |
| `GET /api/registry/v1/modules/:namespace/:name/:provider/:version` | Get version details |
| `GET /api/registry/v1/modules/:namespace/:name/:provider/:version/download` | Download source |
| `GET /api/registry/v1/modules/:namespace/:name` | List providers for module |
| `GET /api/registry/v1/modules` | Search/browse modules |

### 20.2 Module Management API

| Method | Path | Action |
|--------|------|--------|
| POST | `/organizations/:org/registry-modules` | Publish from VCS |
| POST | `/organizations/:org/registry-modules/versions` | Create version |
| PUT | `/registry-modules/:id/versions/:version/upload` | Upload tar.gz |
| DELETE | `/registry-modules/:id` | Delete module |
| DELETE | `/registry-modules/:id/versions/:version` | Delete version |

### 20.3 Module Tests & GPG Keys

- Module test triggering and results API
- GPG key management for module signing
- **Low priority for homelab**

---

## 21. Private Registry — Providers

_Reference: TFE Private Registry Providers API at `references/docs/enterprise/api-docs/private-registry/providers.mdx`; TFE Private Registry Provider Versions at `references/docs/enterprise/api-docs/private-registry/provider-versions-platforms.mdx`_

### 21.1 Standard Registry Protocol

```
GET /api/registry/v1/providers/:namespace/:type/versions
GET /api/registry/v1/providers/:namespace/:type/:version/download/:os/:arch
GET /api/registry/v1/providers/:namespace/:type/:version
GET /api/registry/v1/providers/-/versions
```

### 21.2 Provider Management API

| Method | Path | Action |
|--------|------|--------|
| POST | `/organizations/:org/registry-providers` | Add provider |
| GET | `/organizations/:org/registry-providers` | List providers |
| GET | `/registry-providers/:id` | Show |
| DELETE | `/registry-providers/:id` | Remove |

### 21.3 Provider Version Platforms

- `POST /registry-providers/:id/versions/:version/platforms`
- `DELETE /registry-providers/:id/versions/:version/platforms/:platform_id`
- Platform: os (linux, darwin, windows) + arch (amd64, arm64)
- GPG key management for provider signing

---

## 22. Health Assessments

_Reference: TFE Workspace Health at `references/docs/enterprise/workspaces/health.mdx`; TFE Workspace Settings at `references/docs/enterprise/workspaces/settings/index.mdx`_

### 22.1 Drift Detection

- `assessments-enabled` on workspace
- `assessments-enforced` on organization
- Scheduled runs that detect drift between actual infra and state
- Notification triggers: `assessment:drifted`, `assessment:check_failure`, `assessment:failed`

### 22.2 Continuous Validation

- Pre-apply check evaluation against Terraform `check` blocks
- Check result storage and API

**Low priority for homelab** — skip for MVP.

---

## 23. Data Retention & GC

_Reference: TFE Data Retention Policies API at `references/docs/enterprise/api-docs/data-retention-policies.mdx`_

### 23.1 Retention Policies

- Organization-level retention defaults
- Workspace-level overrides
- Configurable retention for: state versions (count/duration), configuration versions, runs

### 23.2 Garbage Collection

- `backing_data_soft_deleted` → `backing_data_permanently_deleted` lifecycle
- GC scheduler that runs periodically
- Soft-deleted data restorable within window
- Permanent deletion after configurable duration

**Medium priority** — needed for long-running homelab instances to prevent unbounded storage growth.

---

## 24. Tags (Key-Value Bindings)

_Reference: TFE Organization Tags API at `references/docs/enterprise/api-docs/organization-tags.mdx`; TFE Reserved Tag Keys at `references/docs/enterprise/api-docs/reserved-tag-keys.mdx`_

### 24.1 Tag Bindings API

| Method | Path | Action |
|--------|------|--------|
| GET | `/workspaces/:id/tag-bindings` | List workspace tag bindings |
| GET | `/workspaces/:id/effective-tag-bindings` | Direct + inherited from project |
| POST | `/workspaces/:id/tag-bindings` | Add tag bindings |
| DELETE | `/workspaces/:id/tag-bindings` | Remove tag bindings |
| GET | `/projects/:id/tag-bindings` | List project tags |
| GET | `/projects/:id/effective-tag-bindings` | Project tags |

### 24.2 Workspace Filtering by Tags

- List workspaces filtered by tag keys and values
- Reserved tag key management

---

## 25. Admin Operations

_Reference: TFE Admin API docs at `references/docs/enterprise/api-docs/admin/`; TFE Application Administration at `references/docs/enterprise/application-administration/`_

### 25.1 Admin Users

| Method | Path | Action |
|--------|------|--------|
| GET | `/admin/users` | List all users |
| GET | `/admin/users/:id` | Show user |
| PATCH | `/admin/users/:id` | Update (site-admin toggle) |
| DELETE | `/admin/users/:id` | Suspend/delete |
| | | `is-site-admin` attribute |

### 25.2 Admin Organizations

| Method | Path | Action |
|--------|------|--------|
| GET | `/admin/organizations` | List all |
| GET | `/admin/organizations/:name` | Show |
| PATCH | `/admin/organizations/:name` | Update |
| DELETE | `/admin/organizations/:name` | Destroy |

### 25.3 Admin Workspaces

| Method | Path | Action |
|--------|------|--------|
| GET | `/admin/workspaces` | List all |
| GET | `/admin/workspaces/:id` | Show |
| PATCH | `/admin/workspaces/:id` | Update |
| DELETE | `/admin/workspaces/:id` | Delete |

### 25.4 Admin Runs

| Method | Path | Action |
|--------|------|--------|
| GET | `/admin/runs` | List all runs |
| GET | `/admin/runs/:id` | Show |
| POST | `/admin/runs/:id/actions/cancel` | Cancel any run |
| POST | `/admin/runs/:id/actions/force-cancel` | Force cancel |

### 25.5 Admin Terraform/Sentinel/OPA Versions

| Method | Path | Action |
|--------|------|--------|
| GET | `/admin/terraform-versions` | List versions |
| POST | `/admin/terraform-versions` | Add version |
| PATCH | `/admin/terraform-versions/:id` | Update |
| DELETE | `/admin/terraform-versions/:id` | Remove |

Same pattern for Sentinel and OPA versions.

### 25.6 Admin Settings

- `GET /api/v2/admin/settings` — Instance settings
- `PATCH /api/v2/admin/settings` — Update settings

### 25.7 Initial Admin Bootstrap

- First-run setup: create initial admin user
- Bootstrap process for fresh instance (no users yet)
- Default organization creation

### 25.8 Support & Diagnostics

- `POST /api/v1/support-bundle-requests` — Generate bundle
- `GET /api/v1/support-bundle-requests` — List
- `GET /api/v1/support-bundle-requests/:id` — Download
- `GET /api/v1/diagnostics` — Comprehensive health diagnostics

---

## 26. Frontend

### 26.1 Core Views (Phase 1)

| View | Description |
|------|-------------|
| Login | Username/password authentication form |
| Dashboard | Organization listing with navigation |
| Workspace List | Table view with name, version, auto-apply, lock status |
| Workspace Detail | Tabbed view (Overview, Runs, Variables, States, Settings) |
| Create Workspace | Modal with engine selection (tofu/terraform), version, auto-apply |
| Run Detail | Status tracker timeline, log viewer, action buttons |
| State History | Version list with download and JSON viewer |

### 26.2 Workspace Detail Tabs

| Tab | Phase | Description |
|-----|-------|-------------|
| Overview | 1 | Key metadata cards (engine, version, auto-apply) |
| Runs | 1 | Run list with trigger button |
| Variables | 1 | Table + add/delete modal with category/sensitive |
| State Versions | 1 | State version list with download + JSON viewer |
| Settings | 1 | Auto-apply, engine, version config |
| Team Access | 2 | Team permissions management |
| VCS | 2 | Connected repository info |
| Run Triggers | 2 | Cross-workspace run trigger config |
| Notifications | 2 | Webhook URL and trigger config |
| SSH Key | 2 | SSH key assignment |
| Policy Sets | 3 | Attached policy sets display |
| Health | 3 | Drift detection and assessment config |

### 26.3 TFE UI Mirroring

| Feature | Phase | Description |
|---------|-------|-------------|
| Run timeline/progress indicator | 1 | State machine visualization |
| Real-time log viewer | 1 | Dark terminal output |
| Color scheme & typography | 1 | TFE-matching design system |
| Responsive layout | 1 | Desktop-optimized |
| Navigation breadcrumbs | 1 | Org > Workspace > Runs |
| Organization settings | 2 | Org-level configuration |
| Team management | 2 | Create teams, invite users |
| Project management | 2 | Create and assign projects |
| Variable set management | 2 | Create and attach variable sets |
| VCS integration setup | 2 | OAuth flow and webhook config |
| Workspace lock/unlock UI | 1 | Toggle indicators |
| Full run state visualization | 2 | All intermediate states |
| Policy check results | 3 | Sentinel/OPA pass/fail display |
| User profile / account settings | 2 | Update username, email, password |
| Admin dashboard | 3 | Instance management |

---

## 27. Execution Engine & Worker

### 27.1 Worker Queue

The worker runs in-process via a polling loop (`startWorkerQueue`):

```typescript
async function startWorkerQueue() {
  // Poll every 1500ms for pending runs
  // Claim runs atomically (status: pending → planning)
  // Execute in parallel (up to 5 concurrent runs)
}
```

### 27.2 Run Execution Pipeline

```
1. Create temp directory: /tmp/terrence/runs/:run_id/
2. Extract CV tar.gz → temp dir (with path traversal protection)
3. Resolve IaC binary (tofu/terraform × version)
4. Build sanitized environment:
   - Host env whitelist (PATH, HOME, etc.)
   - Block protected keys (LD_PRELOAD, TF_CLI_CONFIG_FILE, etc.)
   - Inject TF_VAR_* for terraform-category variables
   - Inject as env vars for env-category variables
   - Write terraform.auto.tfvars for terraform variables
5. Execute: `tofu init -no-color -input=false`
6. Execute: `tofu plan -no-color -input=false -out=tfplan`
   (with -destroy flag for destroy runs)
7. If auto-apply: `tofu apply -no-color -input=false tfplan`
8. Stream stdout/stderr concurrently → logs DB
9. On success (apply): parse terraform.tfstate → create state version
10. Clean up temp directory
```

### 27.3 Binary Version Management

```
1. Check cache: storage/binaries/:tool/:version/:tool
2. If not cached:
   a. Resolve "latest" via GitHub/HashiCorp API if needed
   b. Download ZIP from releases
   c. Verify SHA256 against published checksums
   d. Extract binary → cache
   e. chmod +x
3. Fallback: system-installed binary via `which`
4. Cross-fallback (opt-in): switch to alternate tool
```

**Supported operations:**
- Dynamic download by exact version (e.g., `1.6.0`, `1.9.3`)
- `latest` resolution via GitHub API (OpenTofu) or checkpoint.hashicorp.com (Terraform)
- Architecture: `amd64`, `arm64`
- OS: `linux`, `darwin`
- Binary caching by `(tool, version)` tuple
- SHA256 verification against published checksums file
- System binary fallback

### 27.4 Version Constraints

Support version constraint expressions:
- Exact: `1.6.0`
- Constraint: `~> 1.0.0`, `>= 1.2, < 2.0`
- Latest: `latest`

Resolve constraint to highest matching release.

### 27.5 Supported Run Modes

| Mode | Flag | Worker Behavior |
|------|------|-----------------|
| Standard | (default) | init → plan → (auto/manual) apply |
| Destroy | `is-destroy: true` | init → plan -destroy → apply |
| Plan-only | `plan-only: true` | init → plan → planned_and_finished |
| Refresh-only | `refresh-only: true` | init → plan -refresh-only → applied |
| Empty apply | `allow-empty-apply: true` | Apply even with no changes |
| Debug | `debugging-mode: true` | Sets `TF_LOG=TRACE` environment |
| Saved plan | `save-plan: true` | Plan, don't become current run |
| Target | `target-addrs: [...]` | Pass `-target=addr` to plan |
| Replace | `replace-addrs: [...]` | Pass `-replace=addr` to plan |

### 27.6 Working Directory

- Execute terraform in subdirectory specified by `working-directory`
- Defaults to root of extracted configuration

---

## 28. Deployment & Operations

### 28.1 Docker Build

```dockerfile
# Multi-stage build
# Stage 1: Bun builder → install deps, build frontend
# Stage 2: Bun slim → copy monorepo, frontend dist, bundled binaries
```

**Container features:**
- `ARG TARGETARCH` for multi-arch builds
- Bundled OpenTofu + Terraform CLI binaries with SHA256 verification
- `drizzle-kit migrate` on container startup
- Unprivileged `appuser` (UID 1000)
- `VOLUME ["/app/backend/storage"]` for state persistence
- Expose port 3000

### 28.2 Configuration (Environment Variables)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PORT` | number | `3000` | HTTP port |
| `DATABASE_URL` | string | `file:./local.db` | SQLite path |
| `STORAGE_DIR` | string | `./storage` | File storage path |
| `SIMULATED_RUNS` | bool | `false` | Bypass binary execution |
| `ALLOW_TOOL_FALLBACK` | bool | `false` | Cross-tool fallback |
| `ALLOW_UNVERIFIED_CHECKSUMS` | bool | `false` | Skip SHA256 verification |
| `NODE_ENV` | string | `production` | Environment mode |
| `LOG_LEVEL` | string | `info` | Logging verbosity |

### 28.3 Database

- SQLite with Drizzle ORM
- WAL journal mode for concurrent access
- Foreign key enforcement
- Migration execution on startup
- **Phase 2:** Migration guide for Postgres

### 28.4 Storage Backend

| Data | Storage | Location |
|------|---------|----------|
| Configuration archives | Filesystem | `storage/cv/:id.tar.gz` |
| State payloads | SQLite BLOB | `state_versions.state_payload` |
| Downloaded binaries | Filesystem | `storage/binaries/:tool/:version/binary` |

**Phase 2:** Abstract storage interface for S3-compatible backends.

### 28.5 Observability

- Structured JSON logging
- Request logging middleware (method, path, status, duration)
- Health check endpoints: `/healthz`, `/readyz`
- Prometheus metrics (Phase 2)

### 28.6 Security

- bcrypt password hashing
- API token storage (plaintext returned once, stored as hash in Phase 2)
- Environment variable sanitization in worker (LD_PRELOAD protection)
- Path traversal protection in archive extraction
- CORS configuration
- Rate limiting per-user

---

## 29. Testing & Compatibility

### 29.1 Integration Test Categories

| Test Area | Phase | Coverage |
|-----------|-------|----------|
| Service discovery | 1 | `GET /.well-known/terraform.json` format |
| Error handling | 1 | 404 format, 401, 422, 500 |
| Auth flows | 1 | Register, login, token create/use, org tokens |
| Organization CRUD | 1 | Create, read, update, delete with cascade |
| Workspace CRUD | 1 | Create (name, engine, version), list, update, delete |
| Variable CRUD | 1 | Create, list, get, update, delete, sensitive |
| State versions | 1 | Create, get current, list, download |
| Configuration versions | 1 | Create, upload, status transitions, download |
| Workspace lock/unlock | 1 | Lock, verify, unlock, verify |
| Run lifecycle | 1 | Create, poll status, read logs |
| Tags | 1 | Create, list, (delete in Phase 2) |
| Extended lifecycle | 1 | Multi-step workflows (register → org → ws → run) |
| Team CRUD | 2 | All team operations |
| Team membership | 2 | Add/remove users |
| Project CRUD | 2 | All project operations |
| Variable sets | 2 | All variable set operations |
| VCS OAuth | 2 | Client and token management |
| Notifications | 2 | CRUD and verify |

### 29.2 Compatibility Targets

| Tool | Purpose | Phase |
|------|---------|-------|
| Terraform CLI `cloud` block | Primary runtime integration | 1 |
| `terraform login` | Token-based auth flow | 1 |
| `go-tfe` (HashiCorp client) | Go ecosystem integration | 2 |
| `terrasnek` (Python client) | Python ecosystem integration | 2 |
| `tfh` (community CLI) | Shell-based management | 2 |

---

## 30. Reference Index

The following is an index of TFE documentation files consumed during specification development, located under `references/docs/enterprise/`.

### API Docs (`references/docs/enterprise/api-docs/`)

| File | Topic |
|------|-------|
| `index.mdx` | API overview, auth, rate limiting, pagination, JSON API spec |
| `account.mdx` | `/api/v2/account/details`, `/update`, `/password` |
| `agents.mdx` | Agent pools and agents API |
| `agent-tokens.mdx` | Agent token CRUD |
| `applies.mdx` | Apply status, attributes, show endpoint |
| `configuration-versions.mdx` | CV CRUD, states, ingress attributes |
| `cost-estimates.mdx` | Cost estimate show endpoint |
| `oauth-clients.mdx` | VCS OAuth client CRUD |
| `oauth-tokens.mdx` | OAuth token list, show, delete |
| `organizations.mdx` | Org CRUD, entitlements, subscription |
| `organization-memberships.mdx` | Invite, list, remove members |
| `organization-tags.mdx` | Org-level tag management |
| `plans.mdx` | Plan show endpoint, attributes, json-output |
| `policy-checks.mdx` | Policy check list, show, override |
| `policy-sets.mdx` | Policy set CRUD, VCS integration, attachments |
| `policies.mdx` | Individual policy CRUD |
| `projects.mdx` | Project CRUD, attributes, tag bindings |
| `run.mdx` | Run CRUD, actions, states, attributes, filters |
| `run-tasks/` | Run task CRUD and execution |
| `ssh-keys.mdx` | SSH key CRUD |
| `state-versions.mdx` | State version CRUD, attributes, upload, download |
| `state-version-outputs.mdx` | State version outputs listing |
| `team-access.mdx` | Team-workspace access CRUD |
| `team-members.mdx` | Team membership management |
| `team-tokens.mdx` | Team token creation, listing, deletion |
| `teams.mdx` | Team CRUD, organization-access permissions |
| `users.mdx` | User show endpoint |
| `variable-sets.mdx` | Variable set CRUD, workspace/project attachments |
| `variables.mdx` | Deprecated global variables API |
| `workspace-variables.mdx` | Workspace-scoped variables |
| `workspaces.mdx` | Workspace CRUD, tags, state consumers, SSH keys, retention |
| `notification-configurations.mdx` | Notification config CRUD, triggers, payloads |
| `data-retention-policies.mdx` | Retention policy API |
| `reserved-tag-keys.mdx` | Reserved tag key management |
| `vcs-events.mdx` | VCS ingress attributes |
| `ping.mdx` | System ping endpoint |
| `admin/` | Admin users, orgs, workspaces, runs, versions, settings |
| `private-registry/modules.mdx` | Registry module endpoints |
| `private-registry/providers.mdx` | Registry provider endpoints |

### Feature Docs (`references/docs/enterprise/`)

| Path | Topic |
|------|-------|
| `run/remote-operations.mdx` | Remote operations overview |
| `run/modes-and-options.mdx` | Run modes (plan-only, destroy, refresh-only, etc.) |
| `run/states.mdx` | Run state documentation |
| `run/ui.mdx` | UI-driven run workflow |
| `run/api.mdx` | API-driven run workflow |
| `run/cli.mdx` | CLI-driven run workflow |
| `run/manage.mdx` | Run management (locking, discarding, canceling) |
| `run/install-software.mdx` | Install software during runs |
| `workspaces/settings/index.mdx` | Workspace settings reference |
| `workspaces/state.mdx` | State management within workspaces |
| `workspaces/tags.mdx` | Workspace tags documentation |
| `workspaces/create.mdx` | Workspace creation |
| `workspaces/best-practices.mdx` | Workspace best practices |
| `workspaces/configurations.mdx` | Configuration management |
| `workspaces/health.mdx` | Health assessments and drift detection |
| `variables/index.mdx` | Variables overview, precedence |
| `variables/managing-variables.mdx` | Variable and variable set management |
| `users-teams-organizations/users.mdx` | User management |
| `users-teams-organizations/api-tokens.mdx` | API token types and usage |
| `users-teams-organizations/teams/` | Team management and permissions |
| `users-teams-organizations/organizations/` | Organization administration |
| `users-teams-organizations/permissions/` | Permission model reference |
| `vcs/` | VCS provider setup and configuration |
| `policy-enforcement/` | Sentinel and OPA policy enforcement |
| `cost-estimation/` | Cost estimation features |
| `registry/` | Private module and provider registry |
| `projects/` | Project management |
| `stacks/` | (HCP Terraform only, not TFE) |
| `application-administration/` | Admin operations, customization, agents, integrations |
| `deploy/` | TFE deployment architecture |
| `saml/` | SAML SSO configuration |
| `scim/` | SCIM provisioning |
| `integrations/` | External integrations |
| `no-code-provisioning/` | No-code workspace provisioning |
| `dynamic-provider-credentials/` | Dynamic provider credentials (HCP only) |
