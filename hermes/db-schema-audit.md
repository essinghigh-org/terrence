# Database Schema Audit — Feature Gap Analysis

**Generated:** July 30, 2026  
**Source:** `/root/terrence/backend/src/db/schema.ts`  
**Routes:** `/root/terrence/backend/src/routes/`  
**Frontend:** `/root/terrence/frontend/src/`

---

## Executive Summary

| Metric | Count |
|---|---|
| Total DB tables | 92 |
| Tables with backend API coverage | 86 |
| Tables **missing backend API endpoints** | 6 |
| Frontend views | 17 |
| Frontend sub-components | 21 |
| Critical feature gaps | ~20 areas without any UI |

---

## All Database Tables (92 total)

### Tables WITH Full Backend API Coverage (CRUD endpoints exist)

These tables are **referenced in route files** with GET/POST/PATCH/DELETE endpoints:

| # | TS Variable | DB Table | Route File(s) |
|---|---|---|---|
| 1 | `users` | `users` | accounts, users, admin |
| 2 | `organizations` | `organizations` | accounts, organizations, admin |
| 3 | `samlSettings` | `saml_settings` | accounts |
| 4 | `scimGroups` | `scim_groups` | scim-admin, scim |
| 5 | `scimUserIdentities` | `scim_user_identities` | scim-admin, scim |
| 6 | `scimGroupMemberships` | `scim_group_memberships` | scim-admin |
| 7 | `scimSettings` | `scim_settings` | scim-admin |
| 8 | `scimTokens` | `scim_tokens` | scim-admin |
| 9 | `registryPartnerships` | `registry_partnerships` | admin-registry-sharing |
| 10 | `reservedTagKeys` | `reserved_tag_keys` | organizations |
| 11 | `organizationMemberships` | `organization_memberships` | accounts, users |
| 12 | `teams` | `teams` | accounts, teams |
| 13 | `teamMemberships` | `team_memberships` | scim-admin, teams |
| 14 | `teamScimGroupMappings` | `team_scim_group_mappings` | scim-admin |
| 15 | `projects` | `projects` | projects, agents |
| 16 | `projectTags` | `project_tags` | projects |
| 17 | `sshKeys` | `ssh_keys` | ssh-keys |
| 18 | `workspaces` | `workspaces` | workspaces, admin |
| 19 | `remoteStateConsumers` | `remote_state_consumers` | workspaces |
| 20 | `dataRetentionPolicies` | `data_retention_policies` | workspaces |
| 21 | `organizationDataRetentionPolicies` | `organization_data_retention_policies` | organizations |
| 22 | `teamWorkspaces` | `team_workspaces` | teams |
| 23 | `notificationConfigurations` | `notification_configurations` | notifications |
| 24 | `workspaceVariables` | `workspace_variables` | workspaces, misc |
| 25 | `configurationVersions` | `configuration_versions` | configuration-versions, agents |
| 26 | `runs` | `runs` | runs, admin |
| 27 | `assessmentResults` | `assessment_results` | assessments |
| 28 | `assessmentCheckResults` | `check_results` | assessments |
| 29 | `logs` | `logs` | agents |
| 30 | `apiTokens` | `api_tokens` | accounts, users |
| 31 | `refreshSessions` | `refresh_sessions` | accounts |
| 32 | `stateVersions` | `state_versions` | state-versions, explorer |
| 33 | `workspaceTags` | `workspace_tags` | explorer |
| 34 | `variableSets` | `variable_sets` | varsets |
| 35 | `variableSetWorkspaces` | `variable_set_workspaces` | varsets |
| 36 | `variableSetProjects` | `variable_set_projects` | varsets |
| 37 | `variableSetVariables` | `variable_set_variables` | varsets |
| 38 | `oauthClients` | `oauth_clients` | oauth-clients |
| 39 | `oauthTokens` | `oauth_tokens` | oauth-clients, github-app-installations |
| 40 | `policySets` | `policy_sets` | policies, agents |
| 41 | `policySetVersions` | `policy_set_versions` | policies |
| 42 | `policySetWorkspaces` | `policy_set_workspaces` | policies |
| 43 | `policies` | `policies` | policies, agents |
| 44 | `policyChecks` | `policy_checks` | policies |
| 45 | `registryModules` | `registry_modules` | registry, gpg-keys |
| 46 | `registryModuleVersions` | `registry_module_versions` | registry, gpg-keys |
| 47 | `noCodeModules` | `no_code_modules` | registry |
| 48 | `noCodeVariableOptions` | `no_code_variable_options` | registry |
| 49 | `noCodeWorkspaceConfigurations` | `no_code_workspace_configurations` | registry |
| 50 | `registryProviders` | `registry_providers` | registry, gpg-keys |
| 51 | `registryGpgKeys` | `registry_gpg_keys` | gpg-keys |
| 52 | `registryProviderVersions` | `registry_provider_versions` | registry, gpg-keys |
| 53 | `registryProviderPlatforms` | `registry_provider_platforms` | registry |
| 54 | `runComments` | `run_comments` | runs |
| 55 | `changeRequests` | `change_requests` | change-requests |
| 56 | `policySetProjects` | `policy_set_projects` | policies |
| 57 | `policySetExclusions` | `policy_set_exclusions` | policies |
| 58 | `policySetParameters` | `policy_set_parameters` | policies |
| 59 | `oauthClientProjects` | `oauth_client_projects` | oauth-clients |
| 60 | `agentPools` | `agent_pools` | agents |
| 61 | `agentPoolAllowedWorkspaces` | `agent_pool_allowed_workspaces` | agents |
| 62 | `agentPoolAllowedProjects` | `agent_pool_allowed_projects` | agents |
| 63 | `agentPoolTokens` | `agent_pool_tokens` | agents |
| 64 | `agents` | `agents` | agents |
| 65 | `runTasks` | `run_tasks` | run-tasks, misc |
| 66 | `workspaceRunTasks` | `workspace_run_tasks` | run-tasks |
| 67 | `taskStages` | `task_stages` | run-tasks, policy-evaluations |
| 68 | `runTaskResults` | `run_task_results` | run-tasks |
| 69 | `policyEvaluations` | `policy_evaluations` | policy-evaluations |
| 70 | `policySetOutcomes` | `policy_set_outcomes` | policy-evaluations |
| 71 | `auditLogs` | `audit_logs` | misc |
| 72 | `runTriggers` | `run_triggers` | misc |
| 73 | `adminTerraformVersions` | `admin_terraform_versions` | admin |
| 74 | `adminSentinelVersions` | `admin_sentinel_versions` | admin |
| 75 | `adminOpaVersions` | `admin_opa_versions` | admin |
| 76 | `githubAppInstallations` | `github_app_installations` | github-app-installations |
| 77 | `githubWebhookDeliveries` | `github_webhook_deliveries` | misc |
| 78 | `workspaceTransfers` | `workspace_transfers` | workspace-transfers |
| 79 | `planExports` | `plan_exports` | plan-exports |
| 80 | `cidrRangeLists` | `cidr_range_lists` | cidr-ranges |
| 81 | `cidrRanges` | `cidr_ranges` | cidr-ranges |
| 82 | `queryRuns` | `query_runs` | queries |
| 83 | `teamProjects` | `team_projects` | team-projects |
| 84 | `moduleTestConfigurations` | `module_test_configurations` | registry |
| 85 | `moduleTestResults` | `module_test_results` | registry |
| 86 | `user2FA` | `user_2fa` | accounts (referenced, no dedicated endpoint) |

---

### Tables MISSING Backend API Endpoints (6)

| # | TS Variable | DB Table | Notes |
|---|---|---|---|
| 1 | **`adminGeneralSettings`** | `admin_general_settings` | No CRUD endpoints — admin general settings live in `admin.ts` but no dedicated table endpoints |
| 2 | **`agentJobs`** | `agent_jobs` | Referenced in `agents.ts` lib but no direct API endpoints |
| 3 | **`oauthDeviceCodes`** | `oauth_device_codes` | Only referenced in `oauth.ts` (non-route file) |
| 4 | **`siteDataRetentionPolicies`** | `site_data_retention_policies` | No endpoints — site-level retention is unexposed |
| 5 | **`supportBundleRequests`** | `support_bundle_requests` | No endpoints |
| 6 | **`user2FA`** | `user_2fa` | Referenced in `accounts.ts` via helper lib but no dedicated 2FA endpoints |

---

## Frontend (UI) Coverage

### Existing Frontend Views (17 pages)

| View | Route | Covers |
|---|---|---|
| Login | `/login` | Auth |
| Register | `/register` | Auth |
| Dashboard | `/app` | Landing |
| Workspaces | `/:orgName` | Workspace list |
| WorkspaceDetail | `/:orgName/workspaces/:name/*` | **(16 sub-sections)** |
| Projects | `/:orgName/projects` | Projects CRUD |
| Registry | `/:orgName/registry` | Modules, providers |
| NoCodeProvisioning | `/:orgName/no-code` | No-code provisioning |
| VariableSets | `/:orgName/variable-sets` | Variable set CRUD |
| VcsIntegrations | `/:orgName/settings/vcs` | GitHub app / OAuth |
| AgentPools | `/:orgName/settings/agents` | Agent pools, agents |
| OrganizationSettings | `/:orgName/settings` | Org settings |
| AccountSettings | `/app/account` | User profile, tokens |
| AdminDashboard | `/app/admin` | Admin overview |
| RunDetail (inside WorkspaceDetail) | `runs/:runId` | Run detail |
| StateHistory (inside WorkspaceDetail) | `states` | State versions |
| RunList (inside WorkspaceDetail) | `runs` | Run list |

### Workspace Detail Sub-Sections (16)

| Section | Route | Has UI? |
|---|---|---|
| Overview | default | ✅ WorkspaceOverview |
| Runs | `/runs` | ✅ RunList |
| States | `/states` | ✅ StateHistory |
| Variables | `/variables` | ✅ WorkspaceVariables |
| Settings/General | `/settings` | ✅ WorkspaceSettings |
| Locking | `/settings/lock` | ✅ WorkspaceDestruction |
| Notifications | `/settings/notifications` | ✅ WorkspaceNotifications |
| Policies | `/settings/policies` | ✅ WorkspacePolicySets |
| Run Tasks | `/settings/tasks` | ✅ WorkspaceRunTasks |
| Run Triggers | `/settings/run-triggers` | ✅ WorkspaceConnections |
| SSH Key | `/settings/ssh` | ✅ WorkspaceVcs (partial) |
| VCS | `/settings/version-control` | ✅ WorkspaceVcs |
| Team Access | `/settings/team-access` | ✅ WorkspaceTeamAccess |
| Health | `/settings/health` | ✅ WorkspaceResources |
| Retention | `/settings/retention` | ✅ WorkspaceRetention |
| Destruction | `/settings/delete` | ✅ WorkspaceDestruction |

---

## Feature Gap Analysis

### 🔴 CRITICAL GAPS — Backend API exists, NO frontend UI

| Feature | API Endpoints | Frontend Status |
|---|---|---|
| **SCIM / SSO management** | full CRUD in `scim-admin.ts`, `scim.ts` | ❌ No SCIM admin view |
| **Policy management** (standalone) | full CRUD in `policies.ts` | ❌ Only `WorkspacePolicySets` component — no dedicated policy set list/create page |
| **CIDR ranges** | full CRUD in `cidr-ranges.ts` | ❌ No UI at all |
| **OAuth clients management** | full CRUD in `oauth-clients.ts` | ❌ No OAuth client list/edit UI |
| **SSH keys management** | full CRUD in `ssh-keys.ts` | ❌ Only per-workspace SSH key assignment — no org-level SSH key management |
| **Plan exports** | full CRUD in `plan-exports.ts` | ❌ No UI |
| **Audit logs viewer** | GET endpoints in `misc.ts` | ❌ No audit log viewer UI |
| **Change requests** | full CRUD in `change-requests.ts` | ❌ No UI |
| **Workspace transfers** | full CRUD in `workspace-transfers.ts` | ❌ No UI |
| **Configuration versions standalone** | full CRUD in `configuration-versions.ts` | ❌ Only accessible via runs |
| **Assessment results / Health** | full CRUD in `assessments.ts` | ❌ WorkspaceResources component is minimal |
| **Run tasks management** (org-level) | full CRUD in `run-tasks.ts` | ❌ Only workspace-level `WorkspaceRunTasks` component |
| **Notification configs** (org/project-level) | full CRUD in `notifications.ts` | ❌ Only workspace-level notifications |
| **Team projects management** | full CRUD in `team-projects.ts` | ❌ No dedicated team projects UI |

### 🟡 MODERATE GAPS — Backend API missing or incomplete

| Feature | Table | Problem |
|---|---|---|
| **Admin General Settings** | `admin_general_settings` | No CRUD endpoints — settings are hardcoded in `admin.ts` route |
| **Site Data Retention Policy** | `site_data_retention_policies` | No endpoints |
| **Support Bundle Requests** | `support_bundle_requests` | No endpoints |
| **User 2FA** | `user_2fa` | Referenced in accounts lib but no dedicated API endpoints for enabling/disabling 2FA |
| **Agent Jobs** | `agent_jobs` | Internal processing table — no direct API endpoints (probably intentional) |
| **Admin pages** (multiple) | versions, users, orgs | API endpoints exist but **no admin frontend views** beyond a basic dashboard |

### 🟢 COMPLETE COVERAGE — API + UI

| Feature | Status |
|---|---|
| Workspaces CRUD | ✅ Full |
| Runs lifecycle | ✅ Full |
| State versions | ✅ Full |
| Variables (workspace) | ✅ Full |
| Variable Sets | ✅ Full |
| Projects CRUD | ✅ Full |
| Registry Modules | ✅ Full |
| Registry Providers | ✅ Full |
| Registry GPG Keys | ✅ Full (API only — via gpg-keys.ts) |
| No-Code Provisioning | ✅ Full |
| Agent Pools & Agents | ✅ Full |
| VCS Integrations | ✅ Full |
| Teams & Permissions | ✅ Full |
| Organization Settings | ✅ Full |
| Account Settings | ✅ Full |

---

## Recommended Priorities

### Top 5 missing UIs (highest user impact):
1. **SCIM / SSO admin UI** — critical for enterprise SSO management
2. **Admin dashboard** — org/user/version management pages
3. **Policy management UI** — standalone policy set CRUD page
4. **Audit logs viewer** — compliance requirement
5. **OAuth client management UI** — needed for VCS integration setup

### Top 5 missing API endpoints:
1. `admin_general_settings` — CRUD endpoints
2. `site_data_retention_policies` — CRUD endpoints
3. `user_2fa` — enable/disable/verify endpoints
4. `support_bundle_requests` — CRUD endpoints
5. `oauthDeviceCodes` — device authorization flow endpoints
