/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey, foreignKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email").unique(),
  passwordHash: text("password_hash").notNull(),
  isSiteAdmin: integer("is_site_admin", { mode: "boolean" }).default(false),
  isSiteAuditor: integer("is_site_auditor", { mode: "boolean" }).default(false),
  isSuspended: integer("is_suspended", { mode: "boolean" }).default(false),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
  theme: text("theme").notNull().default("original-light"),
  // External identity for SAML / OIDC / LDAP provisioned accounts.
  // Both NULL for local accounts. (sso_provider, sso_subject) is unique and
  // the all-or-nothing pairing is enforced by the users_sso_identity_pair_*
  // triggers created in migration 0058 (a table check cannot be added to an
  // existing table portably, so the triggers are the source of truth).
  ssoProvider: text("sso_provider"),
  ssoSubject: text("sso_subject"),
  // True when the site-admin flag was granted through the SAML site-admin
  // attribute; such grants are revoked when the attribute stops matching.
  ssoSiteAdmin: integer("sso_site_admin", { mode: "boolean" }).notNull().default(false),
}, (table) => [
  uniqueIndex("users_sso_identity_idx").on(table.ssoProvider, table.ssoSubject),
]);

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  email: text("email"),
  defaultIacBinary: text("default_iac_binary").default("terraform"),
  defaultTerraformVersion: text("default_terraform_version").default("latest"),
  costEstimationEnabled: integer("cost_estimation_enabled", { mode: "boolean" }).notNull().default(false),
  sessionTimeout: integer("session_timeout"),
  sessionRemember: integer("session_remember", { mode: "boolean" }),
  collaboratorAuthPolicy: text("collaborator_auth_policy").notNull().default("password"),
  userTokensEnabled: integer("user_tokens_enabled", { mode: "boolean" }).notNull().default(true),
  // Stored as an organization preference; agent-pool ownership is checked by
  // the API when the preference is used.
  defaultAgentPoolId: text("default_agent_pool_id"),
  assessmentsEnforced: integer("assessments_enforced", { mode: "boolean" }).notNull().default(false),
  globalModuleSharing: integer("global_module_sharing", { mode: "boolean" }).notNull().default(false),
  globalProviderSharing: integer("global_provider_sharing", { mode: "boolean" }).notNull().default(false),
  accessBetaTools: integer("access_beta_tools", { mode: "boolean" }).notNull().default(false),
  workspaceLimit: integer("workspace_limit"),
  samlEnabled: integer("saml_enabled", { mode: "boolean" }).notNull().default(false),
  ownersTeamSamlRoleId: text("owners_team_saml_role_id"),
  allowForceDeleteWorkspaces: integer("allow_force_delete_workspaces", { mode: "boolean" }).notNull().default(true),
  stacksEnabled: integer("stacks_enabled", { mode: "boolean" }).notNull().default(false),
  showPreReleases: integer("show_pre_releases", { mode: "boolean" }).notNull().default(false),
  defaultExecutionMode: text("default_execution_mode").default("remote"),
  aggregatedCommitStatusEnabled: integer("aggregated_commit_status_enabled", { mode: "boolean" }).notNull().default(true),
  sendPassingStatusesForUntriggeredSpeculativePlans: integer("send_passing_statuses", { mode: "boolean" }).notNull().default(false),
  moduleTestTokenTtl: integer("module_test_token_ttl").notNull().default(600),
});

export const samlSettings = sqliteTable("saml_settings", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  debug: integer("debug", { mode: "boolean" }).notNull().default(false),
  oldIdpCert: text("old_idp_cert"),
  idpCert: text("idp_cert"),
  idpEntityId: text("idp_entity_id"),
  sloEndpointUrl: text("slo_endpoint_url"),
  ssoEndpointUrl: text("sso_endpoint_url"),
  attrUsername: text("attr_username").notNull().default("Username"),
  attrEmail: text("attr_email").notNull().default("email"),
  attrGroups: text("attr_groups").notNull().default("MemberOf"),
  attrSiteAdmin: text("attr_site_admin").notNull().default("SiteAdmin"),
  siteAdminRole: text("site_admin_role").notNull().default("site-admins"),
  ssoApiTokenSessionTimeout: integer("sso_api_token_session_timeout").notNull().default(1_209_600),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

export const scimGroups = sqliteTable("scim_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  externalId: text("external_id"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("scim_groups_name_idx").on(table.name),
  uniqueIndex("scim_groups_external_id_idx").on(table.externalId),
]);

export const scimUserIdentities = sqliteTable("scim_user_identities", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  username: text("username").notNull(),
  externalId: text("external_id"),
  createdAt: integer("created_at").$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("scim_user_identities_user_idx").on(table.userId),
  uniqueIndex("scim_user_identities_username_idx").on(table.username),
  uniqueIndex("scim_user_identities_external_id_idx").on(table.externalId),
]);

export const scimGroupMemberships = sqliteTable("scim_group_memberships", {
  id: text("id").primaryKey(),
  groupId: text("group_id").notNull().references(() => scimGroups.id, { onDelete: "cascade" }),
  scimUserId: text("scim_user_id").notNull().references(() => scimUserIdentities.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("scim_group_memberships_group_user_idx").on(table.groupId, table.scimUserId),
]);

export const scimSettings = sqliteTable("scim_settings", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  siteAdminGroupScimId: text("site_admin_group_scim_id").references(() => scimGroups.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

export const scimTokens = sqliteTable("scim_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  description: text("description"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  expiresAt: integer("expires_at").notNull(),
  lastUsedAt: integer("last_used_at"),
});

export const registryPartnerships = sqliteTable("registry_partnerships", {
  id: text("id").primaryKey(),
  producerOrgId: text("producer_org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  consumerOrgId: text("consumer_org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  modules: integer("modules", { mode: "boolean" }).notNull().default(false),
  providers: integer("providers", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("registry_partnerships_producer_consumer_idx").on(table.producerOrgId, table.consumerOrgId),
]);

export const reservedTagKeys = sqliteTable("reserved_tag_keys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  disableOverrides: integer("disable_overrides", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("reserved_tag_keys_org_key_idx").on(table.orgId, table.key),
]);

export const organizationMemberships = sqliteTable("organization_memberships", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"), // 'owner' or 'member'
  status: text("status").notNull().default("active"), // 'active' or 'invited'
  // Provenance for SAML-managed memberships. NULL for memberships granted by
  // admins directly; 'saml' for memberships created by the SAML group mapper.
  ssoSource: text("sso_source"),
});

export const organizationRoles = sqliteTable("organization_roles", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  permissions: text("permissions", { mode: "json" }).$type<Record<string, boolean>>().notNull().default({}),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [uniqueIndex("organization_roles_org_name_idx").on(table.orgId, table.name)]);

export const organizationMembershipRoles = sqliteTable("organization_membership_roles", {
  membershipId: text("membership_id").notNull().references(() => organizationMemberships.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => organizationRoles.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("organization_membership_roles_membership_role_idx").on(table.membershipId, table.roleId),
]);

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  visibility: text("visibility").notNull().default("organization"), // 'organization' or 'secret'
  ssoTeamId: text("sso_team_id"),
  organizationAccess: text("organization_access", { mode: "json" }).$type<Record<string, boolean>>().notNull().default({}),
  allowMemberTokenManagement: integer("allow_member_token_management", { mode: "boolean" }).default(false),
  // Time-bound policy-override delegation (kanban 18.7): when set, the
  // team's delegate-policy-overrides grant expires at this epoch-millis time.
  // null/0 means no expiry (grant is permanent).
  policyOverrideDelegationExpiresAt: integer("policy_override_delegation_expires_at"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("teams_org_name_idx").on(table.orgId, table.name),
  uniqueIndex("teams_id_org_idx").on(table.id, table.orgId),
]);

export const teamMemberships = sqliteTable("team_memberships", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  // Provenance for SAML-managed memberships. NULL for memberships granted by
  // admins directly; 'saml' for memberships created by the SAML group mapper.
  ssoSource: text("sso_source"),
}, (table) => [
  uniqueIndex("team_memberships_team_user_idx").on(table.teamId, table.userId),
]);

export const teamScimGroupMappings = sqliteTable("team_scim_group_mappings", {
  teamId: text("team_id").primaryKey().references(() => teams.id, { onDelete: "cascade" }),
  scimGroupId: text("scim_group_id").notNull().references(() => scimGroups.id, { onDelete: "cascade" }),
  syncPaused: integer("sync_paused", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  index("team_scim_group_mappings_group_idx").on(table.scimGroupId),
]);

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  defaultExecutionMode: text("default_execution_mode").default("remote"),
  autoDestroyActivityDuration: text("auto_destroy_activity_duration"),
  settingOverwrites: text("setting_overwrites", { mode: "json" }).$type<Record<string, boolean>>(),
  defaultAgentPoolId: text("default_agent_pool_id").references(() => agentPools.id, { onDelete: "set null" }),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("projects_org_name_idx").on(table.orgId, table.name),
  uniqueIndex("projects_org_default_idx").on(table.orgId).where(sql`${table.isDefault} = 1`),
  uniqueIndex("projects_id_org_idx").on(table.id, table.orgId),
]);

export const projectTags = sqliteTable("project_tags", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value"),
}, (table) => [
  uniqueIndex("project_tags_project_key_idx").on(table.projectId, table.key),
]);

export const sshKeys = sqliteTable("ssh_keys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  value: text("value").notNull(), // PEM-encoded private key
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("ssh_keys_org_name_idx").on(table.orgId, table.name),
]);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  sshKeyId: text("ssh_key_id").references(() => sshKeys.id, { onDelete: "set null" }),
  iacBinary: text("iac_binary"), // null inherits from org
  terraformVersion: text("terraform_version").default("latest"),
  workingDirectory: text("working_directory"),
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
  source: text("source").default("tfe-api"),
  autoApply: integer("auto_apply", { mode: "boolean" }).default(false),
  autoApplyRunTrigger: integer("auto_apply_run_trigger", { mode: "boolean" }).default(false),
  fileTriggersEnabled: integer("file_triggers_enabled", { mode: "boolean" }).default(true),
  triggerPrefixes: text("trigger_prefixes", { mode: "json" }).$type<string[]>(),
  triggerPatterns: text("trigger_patterns", { mode: "json" }).$type<string[]>(),
  vcsRepo: text("vcs_repo", { mode: "json" }).$type<{ branch?: string; identifier?: string; oauthTokenId?: string; githubAppInstallationId?: string; ingressSubmodules?: boolean; tagsRegex?: string; cloneUrl?: string }>(),
  queueAllRuns: integer("queue_all_runs", { mode: "boolean" }).default(true),
  speculativeEnabled: integer("speculative_enabled", { mode: "boolean" }).default(true),
  allowDestroyPlan: integer("allow_destroy_plan", { mode: "boolean" }).default(true),
  globalRemoteState: integer("global_remote_state", { mode: "boolean" }).default(false),
  projectRemoteState: integer("project_remote_state", { mode: "boolean" }).default(false),
  executionMode: text("execution_mode").notNull().default("remote"),
  agentPoolId: text("agent_pool_id").references(() => agentPools.id, { onDelete: "set null" }),
  assessmentsEnabled: integer("assessments_enabled", { mode: "boolean" }).default(false),
  autoDestroyAt: text("auto_destroy_at"),
  autoDestroyActivityDuration: text("auto_destroy_activity_duration"),
  inheritsProjectAutoDestroy: integer("inherits_project_auto_destroy", { mode: "boolean" }).notNull().default(false),
  settingOverwrites: text("setting_overwrites", { mode: "json" }).$type<Record<string, boolean>>(),
  locked: integer("locked", { mode: "boolean" }).default(false),
  lockedReason: text("locked_reason"),
  // Ownership metadata (kanban 16.12): operational attribution beyond RBAC.
  // ownedByType is "team" | "user" | "service" | null; ownedById references
  // the team or user row when applicable. This is informational, not
  // permission-enforcing.
  ownedByType: text("owned_by_type"),
  ownedById: text("owned_by_id"),
  contactEmail: text("contact_email"),
  updatedAt: integer("updated_at").$defaultFn(() => Date.now()),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  // Org-scoped workspace listings (permission checks, admin panels, VCS
  // webhook candidate lookups).
  index("workspaces_org_idx").on(table.orgId),
]);

export const remoteStateConsumers = sqliteTable("remote_state_consumers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  consumerWorkspaceId: text("consumer_workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("remote_state_consumers_ws_consumer_idx").on(table.workspaceId, table.consumerWorkspaceId),
]);

export const dataRetentionPolicies = sqliteTable("data_retention_policies", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().unique().references(() => workspaces.id, { onDelete: "cascade" }),
  stateVersionsCount: integer("state_versions_count"),
  deleteOlderThanNDays: integer("delete_older_than_n_days"),
  autoDestroyAt: text("auto_destroy_at"),
  autoDestroyActivityDuration: text("auto_destroy_activity_duration"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const organizationDataRetentionPolicies = sqliteTable("organization_data_retention_policies", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().unique().references(() => organizations.id, { onDelete: "cascade" }),
  stateVersionsCount: integer("state_versions_count"),
  deleteOlderThanNDays: integer("delete_older_than_n_days"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const teamWorkspaces = sqliteTable("team_workspaces", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  access: text("access").notNull().default("write"), // 'read', 'plan', 'write', 'admin', 'custom'
  permissions: text("permissions", { mode: "json" }).$type<Record<string, unknown>>(),
}, (table) => [
  uniqueIndex("team_workspaces_team_workspace_idx").on(table.teamId, table.workspaceId),
]);

export const notificationConfigurations = sqliteTable("notification_configurations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  destinationType: text("destination_type").notNull(), // 'generic', 'slack', 'microsoft-teams', 'email'
  url: text("url").notNull(),
  emailAddresses: text("email_addresses", { mode: "json" }).$type<string[]>(),
  emailAllMembers: integer("email_all_members", { mode: "boolean" }).notNull().default(false),
  emailUserIds: text("email_user_ids", { mode: "json" }).$type<string[]>(),
  triggers: text("triggers", { mode: "json" }).$type<string[]>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(false),
  token: text("token"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const notificationWorkspaceCounters = sqliteTable("notification_workspace_counters", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  configurationCount: integer("configuration_count").notNull().default(0),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

export const workspaceVariables = sqliteTable("workspace_variables", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(),
  sensitive: integer("sensitive", { mode: "boolean" }).default(false),
  hcl: integer("hcl", { mode: "boolean" }).default(false),
  category: text("category").notNull().default("terraform"), // 'terraform' or 'env'
  description: text("description"),
});

export const configurationVersions = sqliteTable("configuration_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  autoQueueRuns: integer("auto_queue_runs", { mode: "boolean" }).notNull().default(true),
  archivePath: text("archive_path"),
  speculative: integer("speculative", { mode: "boolean" }).notNull().default(false),
  provisional: integer("provisional", { mode: "boolean" }).notNull().default(false),
  source: text("source").default("tfe-api"),
  ingressAttributes: text("ingress_attributes", { mode: "json" }).$type<{ commitSha?: string; commitUrl?: string; commitMessage?: string; branch?: string; tag?: string; pullRequestNumber?: number; senderUsername?: string; senderAvatarUrl?: string; senderProviderId?: string; cloneUrl?: string; compareUrl?: string }>(),
  statusTimestamps: text("status_timestamps", { mode: "json" }).$type<{ uploadedAt?: string; archivedAt?: string }>(),
  // Upload-claim lease (todo 278): atomically claims a pending
  // configuration-version before accepting an archive PUT, so two
  // simultaneous signed PUTs cannot race. Claim expires so a crashed
  // upload cannot wedge the version permanently.
  uploadClaimExpiresAt: integer("upload_claim_expires_at"),
  error: text("error"),
  errorMessage: text("error_message"),
  softDeletedAt: integer("soft_deleted_at"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  // Latest-CV-per-workspace lookups and per-workspace version lists.
  index("configuration_versions_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  configurationVersionId: text("configuration_version_id").references(() => configurationVersions.id, { onDelete: "set null" }),
  agentPoolId: text("agent_pool_id").references(() => agentPools.id, { onDelete: "set null" }),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"),
  operation: text("operation").notNull().default("plan_and_apply"),
  message: text("message"),
  isDestroy: integer("is_destroy", { mode: "boolean" }).default(false),
  autoApply: integer("auto_apply", { mode: "boolean" }).notNull().default(false),
  planOnly: integer("plan_only", { mode: "boolean" }).notNull().default(false),
  refresh: integer("refresh", { mode: "boolean" }).notNull().default(true),
  refreshOnly: integer("refresh_only", { mode: "boolean" }).notNull().default(false),
  targetAddrs: text("target_addrs", { mode: "json" }).$type<string[]>(),
  replaceAddrs: text("replace_addrs", { mode: "json" }).$type<string[]>(),
  invokeActionAddrs: text("invoke_action_addrs", { mode: "json" }).$type<string[]>(),
  variables: text("variables", { mode: "json" }).$type<{ key: string; value: string }[]>(),
  logToken: text("log_token").$defaultFn(() => crypto.randomUUID()),
  terraformVersion: text("terraform_version"),
  debuggingMode: integer("debugging_mode", { mode: "boolean" }).notNull().default(false),
  allowEmptyApply: integer("allow_empty_apply", { mode: "boolean" }).notNull().default(false),
  savePlan: integer("save_plan", { mode: "boolean" }).notNull().default(false),
  allowConfigGeneration: integer("allow_config_generation", { mode: "boolean" }).notNull().default(false),
  generatedConfiguration: integer("generated_configuration", { mode: "boolean" }).notNull().default(false),
  executionMode: text("execution_mode").notNull().default("remote"),
  statusTimestamps: text("status_timestamps", { mode: "json" }).$type<Record<string, string>>(),
  planResourceAdditions: integer("plan_resource_additions"),
  planResourceChanges: integer("plan_resource_changes"),
  planResourceDestructions: integer("plan_resource_destructions"),
  planResourceImports: integer("plan_resource_imports"),
  applyResourceAdditions: integer("apply_resource_additions"),
  applyResourceChanges: integer("apply_resource_changes"),
  applyResourceDestructions: integer("apply_resource_destructions"),
  applyResourceImports: integer("apply_resource_imports"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  appliedAt: integer("applied_at"),
  scheduledAt: integer("scheduled_at"),
  softDeletedAt: integer("soft_deleted_at"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  // Hot access paths (benchmarked, kanban perf work): the queue scan is
  // status-first; workspace run lists are workspace-first; scheduled-applies
  // polls are a status+range scan.
  index("runs_workspace_status_created_idx").on(table.workspaceId, table.status, table.createdAt),
  index("runs_status_created_idx").on(table.status, table.createdAt),
  index("runs_status_scheduled_idx").on(table.status, table.scheduledAt),
]);

// Ephemeral per-run credentials (the reference format run-token model). Minted when the worker
// executes a run, stored hashed, revoked on terminal state. Grants ONLY
// registry reads for the run's organization and state access for the run's
// workspace.
export const runTokens = sqliteTable("run_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
}, (table) => [
  index("run_tokens_run_id_idx").on(table.runId),
]);

export const assessmentResults = sqliteTable("assessment_results", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"), // 'pending', 'running', 'completed', 'errored', 'canceled'
  succeeded: integer("succeeded", { mode: "boolean" }),
  drifted: integer("drifted", { mode: "boolean" }),
  errorMessage: text("error_message"),
  resourcesDrifted: integer("resources_drifted").notNull().default(0),
  resourcesUndrifted: integer("resources_undrifted").notNull().default(0),
  allChecksSucceeded: integer("all_checks_succeeded", { mode: "boolean" }),
  checksPassed: integer("checks_passed").notNull().default(0),
  checksFailed: integer("checks_failed").notNull().default(0),
  checksErrored: integer("checks_errored").notNull().default(0),
  checksUnknown: integer("checks_unknown").notNull().default(0),
  jsonOutput: text("json_output", { mode: "json" }).$type<Record<string, unknown>>(),
  jsonSchema: text("json_schema", { mode: "json" }).$type<Record<string, unknown>>(),
  logOutput: text("log_output"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  completedAt: integer("completed_at"),
}, (table) => [
  index("assessment_results_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

export const assessmentCheckResults = sqliteTable("check_results", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  assessmentResultId: text("assessment_result_id").references(() => assessmentResults.id, { onDelete: "cascade" }),
  runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
  address: text("address").notNull(),
  kind: text("kind").notNull().default("check"),
  status: text("status").notNull(), // 'passed', 'failed', 'errored', 'unknown'
  message: text("message"),
  detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  index("check_results_assessment_idx").on(table.assessmentResultId),
  index("check_results_run_idx").on(table.runId),
]);

export const logs = sqliteTable("logs", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  phase: text("phase").notNull(), // 'plan' or 'apply'
  outputText: text("output_text").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("logs_run_phase_idx").on(table.runId, table.phase),
]);

export const runExplanations = sqliteTable("run_explanations", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // 'plan' | 'apply'
  model: text("model").notNull(),
  content: text("content").notNull(),
  thinking: text("thinking"),
  // Keep the physical input_hash column for existing databases while treating
  // it as the stable cache slot key rather than a content hash.
  cacheKey: text("input_hash").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  index("run_explanations_run_kind_idx").on(table.runId, table.kind),
]);

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
  description: text("description"),
  scopes: text("scopes"), // JSON-encoded fine-grained scope definition (null = legacy full-permission token)
  tokenType: text("token_type").notNull().default(""), // org token slot: "" | "audit-trails" | "organization"
  // Team-token discriminator (TFE parity): the singular legacy
  // /teams/:id/authentication-token endpoints must only see the team's single
  // legacy credential, never the modern plural authentication-tokens set.
  legacy: integer("legacy", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  lastUsedAt: integer("last_used_at"),
  expiresAt: integer("expires_at"),
});

// System API tokens are intentionally separate from application user/org/team
// tokens. A valid user token must never authenticate the System API.
export const systemApiTokens = sqliteTable("system_api_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  description: text("description").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  expiresAt: integer("expires_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
});

export const controlPlaneNodes = sqliteTable("control_plane_nodes", {
  id: text("id").primaryKey(),
  hostname: text("hostname").notNull(),
  address: text("address"),
  version: text("version"),
  status: text("status").notNull().default("active"), // active | draining | maintenance
  readinessChecks: text("readiness_checks", { mode: "json" }).$type<Array<{ check: string; status: string }>>().notNull().default([]),
  registeredAt: integer("registered_at").notNull().$defaultFn(() => Date.now()),
  lastHeartbeatAt: integer("last_heartbeat_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("control_plane_nodes_hostname_idx").on(table.hostname),
  index("control_plane_nodes_heartbeat_idx").on(table.status, table.lastHeartbeatAt),
]);

export const refreshSessions = sqliteTable("refresh_sessions", {
  id: text("id").primaryKey(),
  familyId: text("family_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessTokenId: text("access_token_id").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  rotatedAt: integer("rotated_at"),
  revokedAt: integer("revoked_at"),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  mfaVerified: integer("mfa_verified", { mode: "boolean" }).notNull().default(false),
  // Successor link (todo 126): the refresh token this row was rotated INTO.
  // A presented token whose successor is still within the concurrency grace
  // window is a legitimate two-tab race, not reuse — the successor is handed
  // back instead of revoking the family. Replay outside the grace window
  // stays a family-revocation event (todo 127).
  successorHash: text("successor_hash"),
  rotatedAtMs: integer("rotated_at_ms"),
}, (table) => [
  index("refresh_sessions_family_idx").on(table.familyId),
  index("refresh_sessions_user_idx").on(table.userId),
]);

export const stateVersions = sqliteTable("state_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  serial: integer("serial").notNull(),
  statePayload: text("state_payload"),
  status: text("status").default("finalized"),
  jsonState: text("json_state"),
  jsonStateOutputs: text("json_state_outputs"),
  vcsCommitSha: text("vcs_commit_sha"),
  vcsCommitUrl: text("vcs_commit_url"),
  runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
  terraformVersion: text("terraform_version"),
  intermediate: integer("intermediate", { mode: "boolean" }).notNull().default(false),
  softDeletedAt: integer("soft_deleted_at"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("state_versions_ws_serial_idx").on(table.workspaceId, table.serial),
]);

export const workspaceTags = sqliteTable("workspace_tags", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value"),
}, (table) => [
  uniqueIndex("workspace_tags_workspace_key_idx").on(table.workspaceId, table.key),
]);

export const variableSets = sqliteTable("variable_sets", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  parentProjectId: text("parent_project_id").references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  global: integer("global", { mode: "boolean" }).default(false),
  priority: integer("priority", { mode: "boolean" }).default(false),
});

export const variableSetWorkspaces = sqliteTable("variable_set_workspaces", {
  id: text("id").primaryKey(),
  variableSetId: text("variable_set_id").notNull().references(() => variableSets.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("variable_set_workspaces_idx").on(table.variableSetId, table.workspaceId),
]);

export const stacks = sqliteTable("stacks", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  agentPoolId: text("agent_pool_id"),
  executionMode: text("execution_mode").notNull().default("remote"),
  name: text("name").notNull(),
  description: text("description"),
  speculativeEnabled: integer("speculative_enabled", { mode: "boolean" }).notNull().default(false),
  workingDirectory: text("working_directory"),
  triggerPatterns: text("trigger_patterns", { mode: "json" }).$type<string[]>().notNull().default([]),
  triggerDisabled: integer("trigger_disabled", { mode: "boolean" }).notNull().default(false),
  debuggingMode: integer("debugging_mode", { mode: "boolean" }).notNull().default(false),
  vcsIdentifier: text("vcs_identifier"),
  vcsServiceProvider: text("vcs_service_provider"),
  vcsBranch: text("vcs_branch"),
  vcsTagsRegex: text("vcs_tags_regex"),
  vcsDisplayIdentifier: text("vcs_display_identifier"),
  vcsRepositoryHttpUrl: text("vcs_repository_http_url"),
  vcsSparseCheckoutPattern: text("vcs_sparse_checkout_pattern"),
  vcsOAuthTokenId: text("vcs_oauth_token_id"),
  vcsGhaInstallationId: text("vcs_gha_installation_id"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

export const stackVariableSets = sqliteTable("stack_variable_sets", {
  stackId: text("stack_id").notNull().references(() => stacks.id, { onDelete: "cascade" }),
  variableSetId: text("variable_set_id").notNull().references(() => variableSets.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.stackId, table.variableSetId] }),
]);

// Stack lifecycle resources share the same ownership and are intentionally
// stored as typed records: the reference format adds fields to deployment resources more often
// than Terrence needs relational queries over them.
export const stackRecords = sqliteTable("stack_records", {
  id: text("id").primaryKey(),
  stackId: text("stack_id").notNull().references(() => stacks.id, { onDelete: "cascade" }),
  parentId: text("parent_id"),
  recordType: text("record_type").notNull(),
  name: text("name"),
  status: text("status").notNull().default("pending"),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  index("stack_records_stack_type_idx").on(table.stackId, table.recordType),
  index("stack_records_parent_type_idx").on(table.parentId, table.recordType),
]);

/** Stack steps use a separate queue because the normal agent protocol is
 * workspace/run-shaped while the reference format Stack steps are deployment/run-shaped. */
export const stackAgentJobs = sqliteTable("stack_agent_jobs", {
  id: text("id").primaryKey(),
  stackId: text("stack_id").notNull().references(() => stacks.id, { onDelete: "cascade" }),
  deploymentRunId: text("deployment_run_id").notNull(),
  stepId: text("step_id").notNull(),
  agentPoolId: text("agent_pool_id").notNull().references(() => agentPools.id, { onDelete: "cascade" }),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  phase: text("phase").notNull(),
  iacBinary: text("iac_binary").notNull().default("terraform"),
  status: text("status").notNull().default("queued"),
  result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
  errorMessage: text("error_message"),
  claimedAt: integer("claimed_at"),
  completedAt: integer("completed_at"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("stack_agent_jobs_step_phase_idx").on(table.stepId, table.phase),
  index("stack_agent_jobs_pool_status_created_idx").on(table.agentPoolId, table.status, table.createdAt),
  index("stack_agent_jobs_run_status_idx").on(table.deploymentRunId, table.status),
]);

/** One mutable lock row per Stack deployment. It remains held across all
 * plan/apply/convergence steps for the owning deployment run. */
export const stackStateLocks = sqliteTable("stack_state_locks", {
  id: text("id").primaryKey(),
  stackId: text("stack_id").notNull().references(() => stacks.id, { onDelete: "cascade" }),
  deployment: text("deployment").notNull(),
  runId: text("run_id"),
  fencingToken: integer("fencing_token").notNull().default(0),
  acquiredAt: integer("acquired_at"),
  leaseExpiresAt: integer("lease_expires_at"),
  releasedAt: integer("released_at"),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("stack_state_locks_stack_deployment_idx").on(table.stackId, table.deployment),
  index("stack_state_locks_run_idx").on(table.runId),
]);

/** Shared lease-backed queue for work that must survive a process restart or
 * be claimed by any replica. The lock token fences stale workers. */
export const durableJobs = sqliteTable("durable_jobs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  dedupeKey: text("dedupe_key"),
  status: text("status").notNull().default("queued"),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  runAfter: integer("run_after").notNull().$defaultFn(() => Date.now()),
  lockedBy: text("locked_by"),
  lockToken: text("lock_token"),
  leaseExpiresAt: integer("lease_expires_at"),
  heartbeatAt: integer("heartbeat_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  index("durable_jobs_kind_status_run_after_idx").on(table.kind, table.status, table.runAfter),
  uniqueIndex("durable_jobs_kind_dedupe_idx").on(table.kind, table.dedupeKey),
  index("durable_jobs_lease_idx").on(table.status, table.leaseExpiresAt),
]);

/** RSA workload-identity signing keys. Private material is encrypted with
 * the installation secret before it reaches the database. */
export const workloadIdentityKeys = sqliteTable("workload_identity_keys", {
  id: text("id").primaryKey(),
  keyId: text("key_id").notNull().unique(),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  publicJwk: text("public_jwk", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  retiredAt: integer("retired_at"),
  revokedAt: integer("revoked_at"),
});

/** Database lease used to serialize signing-key creation and rotation across
 * application replicas. The fencing token changes on every lease acquisition
 * so a stale owner cannot safely publish a key after losing leadership. */
export const workloadIdentityLeases = sqliteTable("workload_identity_leases", {
  id: text("id").primaryKey(),
  owner: text("owner"),
  leaseExpiresAt: integer("lease_expires_at"),
  fencingToken: integer("fencing_token").notNull().default(0),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

export const workloadIdentityTokens = sqliteTable("workload_identity_tokens", {
  jti: text("jti").primaryKey(),
  runId: text("run_id").notNull(),
  keyId: text("key_id").notNull(),
  audience: text("audience").notNull(),
  subject: text("subject").notNull(),
  issuedAt: integer("issued_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
}, (table) => [
  index("workload_identity_tokens_run_idx").on(table.runId, table.expiresAt),
  index("workload_identity_tokens_expiry_idx").on(table.expiresAt, table.revokedAt),
]);

/** One current, query-friendly Explorer row per workspace. State JSON is
 * parsed when writes happen, not on every organization-wide query. */
export const explorerWorkspaceInventory = sqliteTable("explorer_workspace_inventory", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  workspaceName: text("workspace_name").notNull(),
  workspaceCreatedAt: integer("workspace_created_at").notNull(),
  workspaceUpdatedAt: integer("workspace_updated_at").notNull(),
  terraformVersion: text("terraform_version"),
  executionMode: text("execution_mode"),
  vcsRepoIdentifier: text("vcs_repo_identifier"),
  sourceModuleId: text("source_module_id"),
  projectId: text("project_id"),
  projectName: text("project_name"),
  currentRunStatus: text("current_run_status"),
  currentRunAppliedAt: integer("current_run_applied_at"),
  currentRunExternalId: text("current_run_external_id"),
  currentResourceCount: integer("current_resource_count").notNull().default(0),
  drifted: integer("drifted", { mode: "boolean" }),
  resourcesDrifted: integer("resources_drifted").notNull().default(0),
  resourcesUndrifted: integer("resources_undrifted").notNull().default(0),
  allChecksSucceeded: integer("all_checks_succeeded", { mode: "boolean" }),
  checksPassed: integer("checks_passed").notNull().default(0),
  checksFailed: integer("checks_failed").notNull().default(0),
  checksErrored: integer("checks_errored").notNull().default(0),
  checksUnknown: integer("checks_unknown").notNull().default(0),
  tags: text("tags").notNull().default(""),
  providers: text("providers").notNull().default(""),
  modules: text("modules").notNull().default(""),
  providerItems: text("provider_items").notNull().default("[]"),
  moduleItems: text("module_items").notNull().default("[]"),
  providerCount: integer("provider_count").notNull().default(0),
  moduleCount: integer("module_count").notNull().default(0),
  stateVersionTerraformVersion: text("state_version_terraform_version"),
  stateSerial: integer("state_serial"),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  index("explorer_inventory_org_name_idx").on(table.orgId, table.workspaceName),
  index("explorer_inventory_org_updated_idx").on(table.orgId, table.workspaceUpdatedAt),
]);

export const explorerCatalogItems = sqliteTable("explorer_catalog_items", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  version: text("version").notNull(),
  workspaceCount: integer("workspace_count").notNull().default(0),
  workspaces: text("workspaces").notNull().default(""),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("explorer_catalog_org_kind_key_idx").on(table.orgId, table.kind, table.name, table.source, table.version),
  index("explorer_catalog_org_kind_idx").on(table.orgId, table.kind, table.name),
]);

/** One membership row per workspace/catalog item. Explorer reads can aggregate
 * this indexed relation in pages without rebuilding the whole organization. */
export const explorerCatalogMemberships = sqliteTable("explorer_catalog_memberships", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  workspaceName: text("workspace_name").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  version: text("version").notNull(),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("explorer_catalog_membership_workspace_key_idx").on(table.workspaceId, table.kind, table.name, table.source, table.version),
  index("explorer_catalog_membership_org_key_idx").on(table.orgId, table.kind, table.name, table.source, table.version),
  index("explorer_catalog_membership_workspace_idx").on(table.workspaceId),
]);

export const variableSetProjects = sqliteTable("variable_set_projects", {
  id: text("id").primaryKey(),
  variableSetId: text("variable_set_id").notNull().references(() => variableSets.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("variable_set_projects_idx").on(table.variableSetId, table.projectId),
]);

export const variableSetVariables = sqliteTable("variable_set_variables", {
  id: text("id").primaryKey(),
  variableSetId: text("variable_set_id").notNull().references(() => variableSets.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(),
  sensitive: integer("sensitive", { mode: "boolean" }).default(false),
  hcl: integer("hcl", { mode: "boolean" }).default(false),
  category: text("category").notNull().default("terraform"),
  description: text("description"),
}, (table) => [
  uniqueIndex("variable_set_variables_idx").on(table.variableSetId, table.key),
]);

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  agentPoolId: text("agent_pool_id").references(() => agentPools.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  serviceProvider: text("service_provider").notNull().default("github"), // 'github', 'gitlab', 'bitbucket', etc.
  apiUrl: text("api_url"),
  httpUrl: text("http_url"),
  key: text("key"),
  secret: text("secret"),
  rsaPublicKey: text("rsa_public_key"),
  organizationScoped: integer("organization_scoped", { mode: "boolean" }).default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const oauthTokens = sqliteTable("oauth_tokens", {
  id: text("id").primaryKey(),
  oauthClientId: text("oauth_client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  serviceProviderUser: text("service_provider_user"),
  token: text("token").notNull(),
  sshKey: text("ssh_key"),
  hasSshKey: integer("has_ssh_key", { mode: "boolean" }).default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

// OAuth handshake state (the `state` value exchanged during the VCS provider
// authorization-code / OAuth1 flows). Previously an in-process Map, which
// broke under multi-instance deployment: a callback landing on a different
// replica than the one that started the flow would find no state. Persisted
// here so any replica can read and consume it. `payload` is the full
// OAuthHandshakeState (a discriminated union); `expiresAt` enforces the TTL
// and lets a periodic sweep drop stale rows.
export const oauthHandshakeStates = sqliteTable("oauth_handshake_states", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
}, (table) => [
  index("oauth_handshake_states_expires_idx").on(table.expiresAt),
]);

// Registry module sync lease. Previously an in-process Map (syncInFlight)
// coalesced duplicate syncs within one process, but under multi-instance
// deployment two replicas could both ingest the same module webhook. This
// table provides a cross-replica mutex: the replica that claims the lease for
// a module key runs the sync; others return the module's current versions
// without double-running. `expiresAt` bounds the lease so a crashed replica
// cannot block ingestion forever; a periodic sweep drops expired leases.
export const registrySyncLeases = sqliteTable("registry_sync_leases", {
  key: text("key").primaryKey(),
  owner: text("owner").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  index("registry_sync_leases_expires_idx").on(table.expiresAt),
]);

// Generic cross-replica mutex for operations that must not run concurrently
// across instances (e.g. auth-settings read-modify-write in admin/helpers.ts).
// A caller claims the named lock (INSERT ... ON CONFLICT DO UPDATE where the
// prior lease has expired), polls until it owns it, runs the operation, then
// releases. expiresAt bounds the lock so a crashed holder cannot block the
// name forever; stale locks are reclaimed by the claim's expiry guard. The
// table is created idempotently at boot (src/db/index.ts) for both backends.
export const locks = sqliteTable("locks", {
  name: text("name").primaryKey(),
  owner: text("owner").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  index("locks_expires_idx").on(table.expiresAt),
]);

export const policySets = sqliteTable("policy_sets", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  kind: text("kind").notNull().default("sentinel"), // 'sentinel' or 'opa'
  global: integer("global", { mode: "boolean" }).default(false),
  overridable: integer("overridable", { mode: "boolean" }).default(false),
  agentEnabled: integer("agent_enabled", { mode: "boolean" }).default(false),
  policyToolVersion: text("policy_tool_version"),
  policiesPath: text("policies_path"),
  vcsRepo: text("vcs_repo", { mode: "json" }).$type<{ branch?: string; identifier?: string; oauthTokenId?: string; githubAppInstallationId?: string; ingressSubmodules?: boolean; tagsRegex?: string }>(),
  policyUpdatePatterns: text("policy_update_patterns", { mode: "json" }).$type<string[]>().notNull().default([]),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const policySetVersions = sqliteTable("policy_set_versions", {
  id: text("id").primaryKey(),
  policySetId: text("policy_set_id").notNull().references(() => policySets.id, { onDelete: "cascade" }),
  source: text("source").notNull().default("tfe-api"),
  status: text("status").notNull().default("pending"),
  statusTimestamps: text("status_timestamps", { mode: "json" }).$type<{ uploadedAt?: string; readyAt?: string; erroredAt?: string }>().notNull().default({}),
  ingressAttributes: text("ingress_attributes", { mode: "json" }).$type<{ provider?: string; repository?: string; commitSha?: string; branch?: string; tag?: string; manifest?: string; policyCount?: number }>(),
  error: text("error"),
  archivePath: text("archive_path"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  index("policy_set_versions_set_created_idx").on(table.policySetId, table.createdAt),
]);

export const policySetWorkspaces = sqliteTable("policy_set_workspaces", {
  id: text("id").primaryKey(),
  policySetId: text("policy_set_id").notNull().references(() => policySets.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("policy_set_workspaces_idx").on(table.policySetId, table.workspaceId),
]);

export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  // A policy belongs to an organization. It may be standalone (org-scoped,
  // org_id set, policy_set_id null) or attached to a policy set (policy_set_id
  // set, org_id also set for direct org lookups). the reference format lets policies exist in
  // either form; go-tfe's Policies.Create posts to /organizations/:org/policies.
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  policySetId: text("policy_set_id").references(() => policySets.id, { onDelete: "cascade" }),
  policySetVersionId: text("policy_set_version_id").references(() => policySetVersions.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  kind: text("kind").notNull().default("sentinel"), // 'sentinel' or 'opa'
  enforcementLevel: text("enforcement_level").notNull().default("soft-mandatory"), // 'hard-mandatory', 'soft-mandatory', 'advisory'
  query: text("query"),
  source: text("source"),
  sourcePath: text("source_path"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const policyChecks = sqliteTable("policy_checks", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  policyId: text("policy_id").references(() => policies.id, { onDelete: "set null" }),
  policySetId: text("policy_set_id").references(() => policySets.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"), // 'pending', 'passed', 'soft_failed', 'failed', 'overridden', 'unreachable', 'errored'
  result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),

  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const registryModules = sqliteTable("registry_modules", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  namespace: text("namespace").notNull(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  description: text("description"),
  publishingMechanism: text("publishing_mechanism").notNull().default("manual"), // 'manual', 'vcs'
  publishingWorkflow: text("publishing_workflow"), // 'tag', 'branch'
  vcsConnectionType: text("vcs_connection_type"), // 'github-app', 'oauth-token'
  vcsConnectionId: text("vcs_connection_id"),
  repositoryIdentifier: text("repository_identifier"),
  repositoryDisplayIdentifier: text("repository_display_identifier"),
  repositoryUrl: text("repository_url"),
  sourceDirectory: text("source_directory").notNull().default(""),
  tagPrefix: text("tag_prefix").notNull().default(""),
  branch: text("branch"),
  status: text("status").notNull().default("pending"), // 'pending', 'setup_complete', 'errored'
  lastSuccessfulSyncAt: integer("last_successful_sync_at"),
  lastSyncAttemptAt: integer("last_sync_attempt_at"),
  lastSyncError: text("last_sync_error"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("registry_modules_ns_name_provider_idx").on(table.namespace, table.name, table.provider),
]);

export const registryModuleVersions = sqliteTable("registry_module_versions", {
  id: text("id").primaryKey(),
  moduleId: text("module_id").notNull().references(() => registryModules.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  status: text("status").notNull().default("pending"), // 'pending', 'ok', 'errored'
  archivePath: text("archive_path"),
  source: text("source"),
  keyId: text("key_id"),
  isDeprecated: integer("is_deprecated", { mode: "boolean" }).default(false),
  isRevoked: integer("is_revoked", { mode: "boolean" }).default(false),
  commitSha: text("commit_sha"),
  vcsTag: text("vcs_tag"),
  vcsBranch: text("vcs_branch"),
  sourceDirectory: text("source_directory"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  ingestError: text("ingest_error"),
  publishedAt: integer("published_at"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("registry_module_versions_mod_ver_idx").on(table.moduleId, table.version),
]);

export const noCodeModules = sqliteTable("no_code_modules", {
  id: text("id").primaryKey(),
  moduleId: text("module_id").notNull().references(() => registryModules.id, { onDelete: "cascade" }),
  versionId: text("version_id").notNull().references(() => registryModuleVersions.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("no_code_modules_module_idx").on(table.moduleId),
]);

export const noCodeVariableOptions = sqliteTable("no_code_variable_options", {
  id: text("id").primaryKey(),
  noCodeModuleId: text("no_code_module_id").notNull().references(() => noCodeModules.id, { onDelete: "cascade" }),
  variableName: text("variable_name").notNull(),
  variableType: text("variable_type").notNull(),
  options: text("options", { mode: "json" }).$type<unknown[]>().notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("no_code_variable_options_module_name_idx").on(table.noCodeModuleId, table.variableName),
]);

export const testVariables = sqliteTable("test_variables", {
  id: text("id").primaryKey(),
  moduleId: text("module_id").notNull().references(() => registryModules.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(),
  sensitive: integer("sensitive", { mode: "boolean" }).notNull().default(false),
  hcl: integer("hcl", { mode: "boolean" }).notNull().default(false),
  category: text("category").notNull().default("terraform"),
  description: text("description"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("test_variables_module_key_idx").on(table.moduleId, table.key),
]);

export const noCodeWorkspaceConfigurations = sqliteTable("no_code_workspace_configurations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  noCodeModuleId: text("no_code_module_id").references(() => noCodeModules.id, { onDelete: "set null" }),
  moduleId: text("module_id").references(() => registryModules.id, { onDelete: "set null" }),
  moduleVersionId: text("module_version_id").references(() => registryModuleVersions.id, { onDelete: "set null" }),
  configurationVersionId: text("configuration_version_id").references(() => configurationVersions.id, { onDelete: "set null" }),
  moduleSource: text("module_source").notNull(),
  moduleVersion: text("module_version").notNull(),
  inputs: text("inputs", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("no_code_workspace_configurations_workspace_idx").on(table.workspaceId),
  index("no_code_workspace_configurations_module_idx").on(table.noCodeModuleId),
]);

export const registryProviders = sqliteTable("registry_providers", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  namespace: text("namespace").notNull(),
  type: text("type").notNull(),
  registryName: text("registry_name").notNull().default("private"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("registry_providers_ns_type_idx").on(table.namespace, table.type),
]);

export const registryGpgKeys = sqliteTable("registry_gpg_keys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  namespace: text("namespace").notNull(),
  keyId: text("key_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  asciiArmor: text("ascii_armor").notNull(),
  source: text("source").notNull().default(""),
  sourceUrl: text("source_url"),
  trustSignature: text("trust_signature").notNull().default(""),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("registry_gpg_keys_namespace_key_idx").on(table.namespace, table.keyId),
]);

export const providerSets = sqliteTable("provider_sets", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  providerSource: text("provider_source").notNull(),
  configurationHcl: text("configuration_hcl"),
  global: integer("global", { mode: "boolean" }).default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("provider_sets_org_name_idx").on(table.orgId, table.name),
]);

export const registryProviderVersions = sqliteTable("registry_provider_versions", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull().references(() => registryProviders.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  protocols: text("protocols", { mode: "json" }).$type<string[]>().default(["5.0"]),
  keyId: text("key_id"),
  shasumsUrl: text("shasums_url"),
  shasumsSignatureUrl: text("shasums_signature_url"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("registry_provider_versions_prov_ver_idx").on(table.providerId, table.version),
]);

export const registryProviderPlatforms = sqliteTable("registry_provider_platforms", {
  id: text("id").primaryKey(),
  versionId: text("version_id").notNull().references(() => registryProviderVersions.id, { onDelete: "cascade" }),
  os: text("os").notNull(),
  arch: text("arch").notNull(),
  filename: text("filename").notNull(),
  downloadUrl: text("download_url").notNull(),
  shasum: text("shasum").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("registry_provider_platforms_ver_os_arch_idx").on(table.versionId, table.os, table.arch),
]);

export const runComments = sqliteTable("run_comments", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const changeRequests = sqliteTable("change_requests", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("pending"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  resolvedBy: text("resolved_by").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: integer("resolved_at"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  index("change_requests_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

export const policySetProjects = sqliteTable("policy_set_projects", {
  id: text("id").primaryKey(),
  policySetId: text("policy_set_id").notNull().references(() => policySets.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("policy_set_projects_idx").on(table.policySetId, table.projectId),
]);

// Tag selectors (tag inclusion/exclusion) attached to a policy set.
// Keyed by (policy_set_id, key, value, is_exclude) so tfe_tag_policy_set /
// tfe_tag_policy_set_exclusion round-trip.
export const policySetTagSelectors = sqliteTable("policy_set_tag_selectors", {
  id: text("id").primaryKey(),
  policySetId: text("policy_set_id").notNull().references(() => policySets.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value"),
  isExclude: integer("is_exclude", { mode: "boolean" }).notNull().default(false),
}, (table) => [
  index("policy_set_tag_selectors_pset_idx").on(table.policySetId),
]);

export const policySetExclusions = sqliteTable("policy_set_exclusions", {
  id: text("id").primaryKey(),
  policySetId: text("policy_set_id").notNull().references(() => policySets.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("policy_set_exclusions_idx").on(table.policySetId, table.workspaceId),
]);

export const policySetProjectExclusions = sqliteTable("policy_set_project_exclusions", {
  id: text("id").primaryKey(),
  policySetId: text("policy_set_id").notNull().references(() => policySets.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("policy_set_project_exclusions_idx").on(table.policySetId, table.projectId),
]);

export const policySetParameters = sqliteTable("policy_set_parameters", {
  id: text("id").primaryKey(),
  policySetId: text("policy_set_id").notNull().references(() => policySets.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(),
  sensitive: integer("sensitive", { mode: "boolean" }).default(false),
  hcl: integer("hcl", { mode: "boolean" }).default(false),
});

export const oauthClientProjects = sqliteTable("oauth_client_projects", {
  id: text("id").primaryKey(),
  oauthClientId: text("oauth_client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("oauth_client_projects_idx").on(table.oauthClientId, table.projectId),
]);

export const agentPools = sqliteTable("agent_pools", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  organizationScoped: integer("organization_scoped", { mode: "boolean" }).default(true),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const agentPoolAllowedWorkspaces = sqliteTable("agent_pool_allowed_workspaces", {
  id: text("id").primaryKey(),
  agentPoolId: text("agent_pool_id").notNull().references(() => agentPools.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("agent_pool_allowed_workspaces_pool_workspace_idx").on(table.agentPoolId, table.workspaceId),
]);

export const orgTokenTTLPolicies = sqliteTable("org_token_ttl_policies", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  tokenType: text("token_type").notNull(),
  maxTtlMs: integer("max_ttl_ms").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("org_token_ttl_policies_org_type_idx").on(table.orgId, table.tokenType),
]);

// OIDC identity-provider configuration (tfe_aws/azure/gcp/vault_oidc_configuration).
// Kept in its own table to avoid colliding with the OIDC *login* module (oidc.ts).
export const oidcConfigs = sqliteTable("oidc_configs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  configType: text("config_type").notNull(),
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

// HYOK (hold-your-own-key) configurations reference an OIDC configuration and
// an agent pool (tfe_hyok_configuration).
export const hyokConfigurations = sqliteTable("hyok_configurations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kekId: text("kek_id").notNull(),
  kmsOptions: text("kms_options", { mode: "json" }).$type<Record<string, string>>(),
  agentPoolId: text("agent_pool_id").references(() => agentPools.id, { onDelete: "set null" }),
  oidcConfigId: text("oidc_config_id").notNull(),
  oidcConfigType: text("oidc_config_type").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).default(false),
  status: text("status").notNull().default("ok"),
  error: text("error"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

export const hyokCustomerKeyVersions = sqliteTable("hyok_customer_key_versions", {
  id: text("id").primaryKey(),
  hyokConfigId: text("hyok_config_id").notNull().references(() => hyokConfigurations.id, { onDelete: "cascade" }),
  keyVersion: text("key_version").notNull(),
  encryptedDek: text("encrypted_dek").notNull(),
  customerKeyName: text("customer_key_name").notNull(),
  status: text("status").notNull().default("active"),
  workspacesSecured: integer("workspaces_secured").notNull().default(0),
  error: text("error"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const agentPoolAllowedProjects = sqliteTable("agent_pool_allowed_projects", {
  id: text("id").primaryKey(),
  agentPoolId: text("agent_pool_id").notNull().references(() => agentPools.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("agent_pool_allowed_projects_pool_project_idx").on(table.agentPoolId, table.projectId),
]);

export const agentPoolExcludedWorkspaces = sqliteTable("agent_pool_excluded_workspaces", {
  id: text("id").primaryKey(),
  agentPoolId: text("agent_pool_id").notNull().references(() => agentPools.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("agent_pool_excluded_workspaces_pool_workspace_idx").on(table.agentPoolId, table.workspaceId),
]);

export const agentPoolTokens = sqliteTable("agent_pool_tokens", {
  id: text("id").primaryKey(),
  agentPoolId: text("agent_pool_id").notNull().references(() => agentPools.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  description: text("description"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  lastUsedAt: integer("last_used_at"),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  agentPoolId: text("agent_pool_id").notNull().references(() => agentPools.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("idle"), // 'idle', 'busy', 'exited', 'errored', 'unknown'
  ipAddress: text("ip_address"),
  version: text("version"),
  architecture: text("architecture"),
  iacBinaries: text("iac_binaries", { mode: "json" }).$type<string[]>().notNull().default(["terraform"]),
  accept: text("accept").notNull().default("plan,apply,policy,assessment,stack_prepare,stack_plan,stack_apply,source_bundle,stack_aggregate_outputs,test"),
  requestForwarding: integer("request_forwarding", { mode: "boolean" }).notNull().default(false),
  hyok: integer("hyok", { mode: "boolean" }).notNull().default(false),
  lastPingAt: integer("last_ping_at"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const agentForwardedRequests = sqliteTable("agent_forwarded_requests", {
  id: text("id").primaryKey(),
  agentPoolId: text("agent_pool_id").notNull().references(() => agentPools.id, { onDelete: "cascade" }),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  method: text("method").notNull(),
  url: text("url").notNull(),
  headers: text("headers", { mode: "json" }).$type<Record<string, string[]>>().notNull().default({}),
  body: text("body"),
  status: text("status").notNull().default("queued"),
  responseStatus: integer("response_status"),
  responseHeaders: text("response_headers", { mode: "json" }).$type<Record<string, string[]>>(),
  responseBody: text("response_body"),
  errorMessage: text("error_message"),
  claimedAt: integer("claimed_at"),
  completedAt: integer("completed_at"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  index("agent_forwarded_requests_pool_status_created_idx").on(table.agentPoolId, table.status, table.createdAt),
]);

export const agentJobs = sqliteTable("agent_jobs", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  agentPoolId: text("agent_pool_id").notNull().references(() => agentPools.id, { onDelete: "cascade" }),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  phase: text("phase").notNull(), // 'plan' or 'apply'
  // Resolved IaC binary for this job (workspace.iac_binary ?? 'terraform' at
  // queue time). Capability filtering in claimAgentJob matches against the
  // claiming agent's declared iac_binaries. The 'terraform' default preserves
  // pre-capability behavior: jobs created before this column existed (or by
  // direct inserts) stay claimable by plain tfc-agents.
  iacBinary: text("iac_binary").notNull().default("terraform"),
  status: text("status").notNull().default("queued"), // 'queued', 'claimed', 'completed', 'errored'
  result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
  errorMessage: text("error_message"),
  claimedAt: integer("claimed_at"),
  completedAt: integer("completed_at"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("agent_jobs_run_phase_idx").on(table.runId, table.phase),
  index("agent_jobs_pool_status_created_idx").on(table.agentPoolId, table.status, table.createdAt),
]);


export const runTasks = sqliteTable("run_tasks", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  url: text("url").notNull(),
  category: text("category").default("general"),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  hmacKey: text("hmac_key"),
  globalConfiguration: text("global_configuration", { mode: "json" }).$type<{ enabled: boolean; stages: string[]; enforcementLevel: string }>(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const workspaceRunTasks = sqliteTable("workspace_run_tasks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  runTaskId: text("run_task_id").notNull().references(() => runTasks.id, { onDelete: "cascade" }),
  stage: text("stage").notNull().default("post_plan"), // 'pre_plan', 'post_plan', 'pre_apply', 'post_apply'
  enforcementLevel: text("enforcement_level").notNull().default("advisory"), // 'must_pass', 'advisory'
}, (table) => [
  uniqueIndex("workspace_run_tasks_idx").on(table.workspaceId, table.runTaskId),
]);

export const taskStages = sqliteTable("task_stages", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(), // 'pre_plan', 'post_plan', 'pre_apply', 'post_apply'
  status: text("status").notNull().default("pending"), // 'pending', 'running', 'passed', 'failed', 'awaiting_override', 'errored', 'canceled', 'unreachable'
  statusTimestamps: text("status_timestamps", { mode: "json" }).$type<Record<string, string>>(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const runTaskResults = sqliteTable("run_task_results", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  runTaskId: text("run_task_id").notNull().references(() => runTasks.id, { onDelete: "cascade" }),
  taskStageId: text("task_stage_id").references(() => taskStages.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("passed"),
  message: text("message"),
  url: text("url"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const policyEvaluations = sqliteTable("policy_evaluations", {
  id: text("id").primaryKey(),
  taskStageId: text("task_stage_id").references(() => taskStages.id, { onDelete: "cascade" }),
  runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("passed"), // 'pending', 'passed', 'failed', 'errored'
  policyKind: text("policy_kind").default("opa"),
  policyToolVersion: text("policy_tool_version").default("0.44.0"),
  resultCount: text("result_count", { mode: "json" }).$type<Record<string, number>>(),
  statusTimestamps: text("status_timestamps", { mode: "json" }).$type<Record<string, string>>(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const policySetOutcomes = sqliteTable("policy_set_outcomes", {
  id: text("id").primaryKey(),
  policyEvaluationId: text("policy_evaluation_id").notNull().references(() => policyEvaluations.id, { onDelete: "cascade" }),
  policySetName: text("policy_set_name"),
  policyName: text("policy_name"),
  enforcementLevel: text("enforcement_level").notNull().default("advisory"), // 'advisory', 'mandatory'
  status: text("status").notNull().default("passed"), // 'passed', 'failed', 'errored'
  query: text("query"),
  description: text("description"),
  error: text("error"),
  overridable: integer("overridable", { mode: "boolean" }).default(false),
  resultCount: text("result_count", { mode: "json" }).$type<Record<string, number>>(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  details: text("details", { mode: "json" }),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const runTriggers = sqliteTable("run_triggers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sourceWorkspaceId: text("source_workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("run_triggers_ws_src_idx").on(table.workspaceId, table.sourceWorkspaceId),
]);

export const adminTerraformVersions = sqliteTable("admin_terraform_versions", {
  id: text("id").primaryKey(),
  version: text("version").notNull().unique(),
  url: text("url"),
  sha: text("sha"),
  deprecated: integer("deprecated", { mode: "boolean" }).default(false),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  isDefault: integer("is_default", { mode: "boolean" }).default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const adminSentinelVersions = sqliteTable("admin_sentinel_versions", {
  id: text("id").primaryKey(),
  version: text("version").notNull().unique(),
  url: text("url"),
  sha: text("sha"),
  deprecated: integer("deprecated", { mode: "boolean" }).default(false),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  isDefault: integer("is_default", { mode: "boolean" }).default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const adminOpaVersions = sqliteTable("admin_opa_versions", {
  id: text("id").primaryKey(),
  version: text("version").notNull().unique(),
  url: text("url"),
  sha: text("sha"),
  deprecated: integer("deprecated", { mode: "boolean" }).default(false),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  isDefault: integer("is_default", { mode: "boolean" }).default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const githubAppInstallations = sqliteTable("github_app_installations", {
  id: text("id").primaryKey(), // e.g. "ghain-12345"
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  installationId: integer("installation_id").notNull(),
  iconUrl: text("icon_url"),
  installationType: text("installation_type").default("Organization"), // "User" or "Organization"
  installationUrl: text("installation_url"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("github_app_installations_org_installation_idx").on(table.orgId, table.installationId),
]);

export const githubWebhookDeliveries = sqliteTable("github_webhook_deliveries", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("processing"),
  receivedAt: integer("received_at").notNull().$defaultFn(() => Date.now()),
  processedAt: integer("processed_at"),
});

export const workspaceTransfers = sqliteTable("workspace_transfers", {
  id: text("id").primaryKey(),
  sourceWorkspaceId: text("source_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  destinationOrgId: text("destination_org_id").references(() => organizations.id, { onDelete: "set null" }),
  destinationProjectId: text("destination_project_id").references(() => projects.id, { onDelete: "set null" }),
  approvalMode: text("approval_mode").notNull().default("auto"),
  cleanupOnFailure: integer("cleanup_on_failure", { mode: "boolean" }).default(true),
  historyCutoff: text("history_cutoff"),
  policySetMode: text("policy_set_mode").notNull().default("move"),
  variableMode: text("variable_mode").notNull().default("move"),
  workspacePrefix: text("workspace_prefix"),
  workspaceSuffix: text("workspace_suffix"),
  status: text("status").notNull().default("pending"),
  pauseReason: text("pause_reason"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

export const planExports = sqliteTable("plan_exports", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull(),
  dataType: text("data_type").notNull().default("sentinel-mock-bundle-v0"),
  status: text("status").notNull().default("queued"),
  downloadUrl: text("download_url"),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const cidrRangeLists = sqliteTable("cidr_range_lists", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  enforcementScope: text("enforcement_scope").notNull().default("organization"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

export const cidrRanges = sqliteTable("cidr_ranges", {
  id: text("id").primaryKey(),
  cidrRangeListId: text("cidr_range_list_id").notNull().references(() => cidrRangeLists.id, { onDelete: "cascade" }),
  value: text("value").notNull(),
  description: text("description"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const cidrRangeListAgentPools = sqliteTable("cidr_range_list_agent_pools", {
  id: text("id").primaryKey(),
  cidrRangeListId: text("cidr_range_list_id").notNull().references(() => cidrRangeLists.id, { onDelete: "cascade" }),
  agentPoolId: text("agent_pool_id").notNull().references(() => agentPools.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("cidr_range_list_agent_pools_idx").on(table.cidrRangeListId, table.agentPoolId),
]);

export const explorerSavedQueries = sqliteTable("explorer_saved_queries", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  queryType: text("query_type").notNull(),
  query: text("query", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const queryRuns = sqliteTable("query_runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  source: text("source").notNull().default("tfe-api"),
  variables: text("variables", { mode: "json" }).$type<Record<string, unknown>>(),
  status: text("status").notNull().default("pending"),
  logReadUrl: text("log_read_url"),
  statusTimestamps: text("status_timestamps", { mode: "json" }).$type<Record<string, string>>(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  canceledBy: text("canceled_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const teamProjects = sqliteTable("team_projects", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  access: text("access").notNull().default("read"),
  projectAccess: text("project_access", { mode: "json" }).$type<Record<string, string>>(),
  workspaceAccess: text("workspace_access", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("team_projects_team_project_idx").on(table.teamId, table.projectId),
  foreignKey({
    columns: [table.teamId, table.organizationId],
    foreignColumns: [teams.id, teams.orgId],
    name: "team_projects_team_org_fk",
  }),
  foreignKey({
    columns: [table.projectId, table.organizationId],
    foreignColumns: [projects.id, projects.orgId],
    name: "team_projects_project_org_fk",
  }),
]);

export const notificationConfigurationWorkspaceExclusions = sqliteTable("notification_configuration_workspace_exclusions", {
  id: text("id").primaryKey(),
  notificationConfigurationId: text("notification_configuration_id").notNull().references(() => notificationConfigurations.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("notification_configuration_workspace_exclusions_idx").on(table.notificationConfigurationId, table.workspaceId),
]);

export const adminGeneralSettings = sqliteTable("admin_general_settings", {
  id: text("id").primaryKey(),
  limitUserOrganizationCreation: integer("limit_user_organization_creation", { mode: "boolean" }).notNull().default(true),
  apiRateLimitingEnabled: integer("api_rate_limiting_enabled", { mode: "boolean" }).notNull().default(true),
  apiRateLimit: integer("api_rate_limit").notNull().default(30),
  planTimeout: text("plan_timeout").notNull().default("2h"),
  applyTimeout: text("apply_timeout").notNull().default("24h"),
  sendPassingStatusesForUntriggeredSpeculativePlans: integer("send_passing_statuses", { mode: "boolean" }).notNull().default(false),
  allowSpeculativePlansOnPullRequestsFromForks: integer("allow_speculative_plans_forks", { mode: "boolean" }).notNull().default(false),
  defaultRemoteStateAccess: integer("default_remote_state_access", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

export const siteDataRetentionPolicies = sqliteTable("site_data_retention_policies", {
  id: text("id").primaryKey(),
  stateVersionsCount: integer("state_versions_count"),
  deleteOlderThanNDays: integer("delete_older_than_n_days"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

/** Durable storage for site-admin setting groups whose shape is API-defined. */
export const adminSettings = sqliteTable("admin_settings", {
  id: text("id").primaryKey(),
  values: text("values", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

/** Single-use SAML/OIDC state shared by all backend instances. */
export const ssoChallenges = sqliteTable("sso_challenges", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  index("sso_challenges_kind_expires_idx").on(table.kind, table.expiresAt),
  index("sso_challenges_expires_idx").on(table.expiresAt),
]);

export const supportBundleRequests = sqliteTable("support_bundle_requests", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("pending"),
  downloadUrl: text("download_url"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const moduleTestConfigurations = sqliteTable("module_test_configurations", {
  id: text("id").primaryKey(),
  moduleId: text("module_id").notNull().references(() => registryModules.id, { onDelete: "cascade" }),
  oidcEnabled: integer("oidc_enabled", { mode: "boolean" }).notNull().default(false),
  oidcProvider: text("oidc_provider"),
  oidcConfiguration: text("oidc_configuration", { mode: "json" }).$type<Record<string, unknown> | null>(),
  oidcProviderUrl: text("oidc_provider_url"),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

export const moduleTestConfigurationVersions = sqliteTable("module_test_configuration_versions", {
  id: text("id").primaryKey(),
  moduleId: text("module_id").notNull().references(() => registryModules.id, { onDelete: "cascade" }),
  archivePath: text("archive_path"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  uploadedAt: integer("uploaded_at"),
}, (table) => [
  index("module_test_configuration_versions_module_created_idx").on(table.moduleId, table.createdAt),
]);

export const moduleTestRuns = sqliteTable("module_test_runs", {
  id: text("id").primaryKey(),
  moduleId: text("module_id").notNull().references(() => registryModules.id, { onDelete: "cascade" }),
  versionId: text("version_id").notNull().references(() => registryModuleVersions.id, { onDelete: "cascade" }),
  configurationVersionId: text("configuration_version_id").references(() => moduleTestConfigurationVersions.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"),
  testStatus: text("test_status"),
  testsPassed: integer("tests_passed"),
  testsFailed: integer("tests_failed"),
  testsErrored: integer("tests_errored"),
  testsSkipped: integer("tests_skipped"),
  verbose: integer("verbose", { mode: "boolean" }).notNull().default(false),
  filters: text("filters", { mode: "json" }).$type<string[]>().notNull().default([]),
  testDirectory: text("test_directory").notNull().default("tests"),
  variables: text("variables", { mode: "json" }).$type<{ key: string; value: string }[]>().notNull().default([]),
  source: text("source").notNull().default("tfe-api"),
  message: text("message"),
  output: text("output"),
  error: text("error"),
  oidcTokenGeneratedAt: integer("oidc_token_generated_at"),
  oidcTokenExpiresAt: integer("oidc_token_expires_at"),
  executionPid: integer("execution_pid"),
  executionStartedAt: integer("execution_started_at"),
  executionStage: text("execution_stage"),
  executionDirectory: text("execution_directory"),
  executionResultPath: text("execution_result_path"),
  executionTokenIds: text("execution_token_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  index("module_test_runs_module_created_idx").on(table.moduleId, table.createdAt),
  index("module_test_runs_version_created_idx").on(table.versionId, table.createdAt),
]);

export const moduleTestResults = sqliteTable("module_test_results", {
  id: text("id").primaryKey(),
  versionId: text("version_id").notNull().references(() => registryModuleVersions.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  output: text("output"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const oauthDeviceCodes = sqliteTable("oauth_device_codes", {
  deviceCode: text("device_code").primaryKey(),
  userCode: text("user_code").notNull().unique(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"), // 'pending', 'authorized', 'denied', 'expired'
  token: text("token"),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const user2FA = sqliteTable("user_2fa", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  // TOTP seeds are encrypted at rest (todo 110-112) with the AES-256-GCM
  // secret layer ("enc:v1:..." prefix). NULL = plaintext seed written before
  // encryption shipped; migrated transparently on first successful verify.
  secretEncrypted: text("secret_encrypted"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});
