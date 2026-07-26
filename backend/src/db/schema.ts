import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email").unique(),
  passwordHash: text("password_hash").notNull(),
  isSiteAdmin: integer("is_site_admin", { mode: "boolean" }).default(false),
});

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  defaultIacBinary: text("default_iac_binary").default("tofu"),
  defaultTerraformVersion: text("default_terraform_version").default("latest"),
});

export const organizationMemberships = sqliteTable("organization_memberships", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"), // 'owner' or 'member'
  status: text("status").notNull().default("active"), // 'active' or 'invited'
});

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  visibility: text("visibility").notNull().default("organization"), // 'organization' or 'secret'
  ssoTeamId: text("sso_team_id"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("teams_org_name_idx").on(table.orgId, table.name),
]);

export const teamMemberships = sqliteTable("team_memberships", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("team_memberships_team_user_idx").on(table.teamId, table.userId),
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
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("projects_org_name_idx").on(table.orgId, table.name),
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
  autoApply: integer("auto_apply", { mode: "boolean" }).default(false),
  autoApplyRunTrigger: integer("auto_apply_run_trigger", { mode: "boolean" }).default(false),
  fileTriggersEnabled: integer("file_triggers_enabled", { mode: "boolean" }).default(true),
  triggerPrefixes: text("trigger_prefixes", { mode: "json" }).$type<string[]>(),
  triggerPatterns: text("trigger_patterns", { mode: "json" }).$type<string[]>(),
  vcsRepo: text("vcs_repo", { mode: "json" }).$type<{ branch?: string; identifier?: string; oauthTokenId?: string; ingressSubmodules?: boolean; tagsRegex?: string }>(),
  queueAllRuns: integer("queue_all_runs", { mode: "boolean" }).default(true),
  speculativeEnabled: integer("speculative_enabled", { mode: "boolean" }).default(true),
  allowDestroyPlan: integer("allow_destroy_plan", { mode: "boolean" }).default(true),
  globalRemoteState: integer("global_remote_state", { mode: "boolean" }).default(false),
  projectRemoteState: integer("project_remote_state", { mode: "boolean" }).default(false),
  agentPoolId: text("agent_pool_id").references(() => agentPools.id, { onDelete: "set null" }),
  assessmentsEnabled: integer("assessments_enabled", { mode: "boolean" }).default(false),
  autoDestroyAt: text("auto_destroy_at"),
  autoDestroyActivityDuration: text("auto_destroy_activity_duration"),
  settingOverwrites: text("setting_overwrites", { mode: "json" }).$type<Record<string, boolean>>(),
  locked: integer("locked", { mode: "boolean" }).default(false),
  lockedReason: text("locked_reason"),
});

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
  autoDestroyAt: text("auto_destroy_at"),
  autoDestroyActivityDuration: text("auto_destroy_activity_duration"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const teamWorkspaces = sqliteTable("team_workspaces", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  access: text("access").notNull().default("write"), // 'read', 'plan', 'write', 'admin', 'custom'
  permissions: text("permissions", { mode: "json" }).$type<Record<string, boolean>>(),
}, (table) => [
  uniqueIndex("team_workspaces_team_workspace_idx").on(table.teamId, table.workspaceId),
]);

export const notificationConfigurations = sqliteTable("notification_configurations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  destinationType: text("destination_type").notNull(), // 'generic', 'slack', 'microsoft-teams'
  url: text("url").notNull(),
  triggers: text("triggers", { mode: "json" }).$type<string[]>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  token: text("token"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
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
  archivePath: text("archive_path"),
  speculative: integer("speculative", { mode: "boolean" }).notNull().default(false),
  provisional: integer("provisional", { mode: "boolean" }).notNull().default(false),
  source: text("source").default("tfe-api"),
  ingressAttributes: text("ingress_attributes", { mode: "json" }).$type<{ commitSha?: string; commitUrl?: string; commitMessage?: string; branch?: string; tag?: string; pullRequestNumber?: number; senderUsername?: string; cloneUrl?: string; compareUrl?: string }>(),
  statusTimestamps: text("status_timestamps", { mode: "json" }).$type<{ uploadedAt?: string; archivedAt?: string }>(),
  error: text("error"),
  errorMessage: text("error_message"),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  configurationVersionId: text("configuration_version_id").references(() => configurationVersions.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"),
  message: text("message"),
  isDestroy: integer("is_destroy", { mode: "boolean" }).default(false),
  autoApply: integer("auto_apply", { mode: "boolean" }).notNull().default(false),
  planOnly: integer("plan_only", { mode: "boolean" }).notNull().default(false),
  refresh: integer("refresh", { mode: "boolean" }).notNull().default(true),
  refreshOnly: integer("refresh_only", { mode: "boolean" }).notNull().default(false),
  targetAddrs: text("target_addrs", { mode: "json" }).$type<string[]>(),
  replaceAddrs: text("replace_addrs", { mode: "json" }).$type<string[]>(),
  variables: text("variables", { mode: "json" }).$type<Array<{ key: string; value: string }>>(),
  logToken: text("log_token").$defaultFn(() => crypto.randomUUID()),
  terraformVersion: text("terraform_version"),
  debuggingMode: integer("debugging_mode", { mode: "boolean" }).notNull().default(false),
  allowEmptyApply: integer("allow_empty_apply", { mode: "boolean" }).notNull().default(false),
  savePlan: integer("save_plan", { mode: "boolean" }).notNull().default(false),
  allowConfigGeneration: integer("allow_config_generation", { mode: "boolean" }).notNull().default(false),
  statusTimestamps: text("status_timestamps", { mode: "json" }).$type<Record<string, string>>(),
  planResourceAdditions: integer("plan_resource_additions"),
  planResourceChanges: integer("plan_resource_changes"),
  planResourceDestructions: integer("plan_resource_destructions"),
  applyResourceAdditions: integer("apply_resource_additions"),
  applyResourceChanges: integer("apply_resource_changes"),
  applyResourceDestructions: integer("apply_resource_destructions"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
});

export const logs = sqliteTable("logs", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  phase: text("phase").notNull(), // 'plan' or 'apply'
  outputText: text("output_text").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("logs_run_phase_idx").on(table.runId, table.phase),
]);

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
  description: text("description"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  lastUsedAt: integer("last_used_at"),
  expiresAt: integer("expires_at"),
});

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
  category: text("category").notNull().default("terraform"),
  description: text("description"),
}, (table) => [
  uniqueIndex("variable_set_variables_idx").on(table.variableSetId, table.key),
]);

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  serviceProvider: text("service_provider").notNull().default("github"), // 'github', 'gitlab', 'bitbucket', etc.
  apiUrl: text("api_url"),
  httpUrl: text("http_url"),
  key: text("key"),
  secret: text("secret"),
  rsaPublicKey: text("rsa_public_key"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const oauthTokens = sqliteTable("oauth_tokens", {
  id: text("id").primaryKey(),
  oauthClientId: text("oauth_client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  serviceProviderUser: text("service_provider_user"),
  token: text("token").notNull(),
  hasSshKey: integer("has_ssh_key", { mode: "boolean" }).default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const policySets = sqliteTable("policy_sets", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  kind: text("kind").notNull().default("sentinel"), // 'sentinel' or 'opa'
  global: integer("global", { mode: "boolean" }).default(false),
  overridable: integer("overridable", { mode: "boolean" }).default(true),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const policySetWorkspaces = sqliteTable("policy_set_workspaces", {
  id: text("id").primaryKey(),
  policySetId: text("policy_set_id").notNull().references(() => policySets.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("policy_set_workspaces_idx").on(table.policySetId, table.workspaceId),
]);

export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  policySetId: text("policy_set_id").notNull().references(() => policySets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  enforcementLevel: text("enforcement_level").notNull().default("soft-mandatory"), // 'hard-mandatory', 'soft-mandatory', 'advisory'
  query: text("query"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const policyChecks = sqliteTable("policy_checks", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  policyId: text("policy_id").references(() => policies.id, { onDelete: "set null" }),
  policySetId: text("policy_set_id").references(() => policySets.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"), // 'pending', 'passed', 'soft_failed', 'failed', 'overridden', 'unreachable', 'errored'
  result: text("result", { mode: "json" }).$type<Record<string, any>>(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const registryModules = sqliteTable("registry_modules", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  namespace: text("namespace").notNull(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("registry_modules_ns_name_provider_idx").on(table.namespace, table.name, table.provider),
]);

export const registryModuleVersions = sqliteTable("registry_module_versions", {
  id: text("id").primaryKey(),
  moduleId: text("module_id").notNull().references(() => registryModules.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  status: text("status").notNull().default("pending"), // 'pending', 'ok', 'errored'
  archivePath: text("archive_path"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (table) => [
  uniqueIndex("registry_module_versions_mod_ver_idx").on(table.moduleId, table.version),
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

export const registryProviderVersions = sqliteTable("registry_provider_versions", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull().references(() => registryProviders.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  protocols: text("protocols", { mode: "json" }).$type<string[]>().default(["5.0"]),
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

export const policySetProjects = sqliteTable("policy_set_projects", {
  id: text("id").primaryKey(),
  policySetId: text("policy_set_id").notNull().references(() => policySets.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("policy_set_projects_idx").on(table.policySetId, table.projectId),
]);

export const policySetExclusions = sqliteTable("policy_set_exclusions", {
  id: text("id").primaryKey(),
  policySetId: text("policy_set_id").notNull().references(() => policySets.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("policy_set_exclusions_idx").on(table.policySetId, table.workspaceId),
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

export const agentPoolTokens = sqliteTable("agent_pool_tokens", {
  id: text("id").primaryKey(),
  agentPoolId: text("agent_pool_id").notNull().references(() => agentPools.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  description: text("description"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  lastUsedAt: integer("last_used_at"),
});

export const runTasks = sqliteTable("run_tasks", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  url: text("url").notNull(),
  category: text("category").default("general"),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  hmacKey: text("hmac_key"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const workspaceRunTasks = sqliteTable("workspace_run_tasks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  runTaskId: text("run_task_id").notNull().references(() => runTasks.id, { onDelete: "cascade" }),
  stage: text("stage").notNull().default("post_plan"), // 'pre_plan', 'post_plan'
  enforcementLevel: text("enforcement_level").notNull().default("advisory"), // 'must_pass', 'advisory'
}, (table) => [
  uniqueIndex("workspace_run_tasks_idx").on(table.workspaceId, table.runTaskId),
]);

export const runTaskResults = sqliteTable("run_task_results", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  runTaskId: text("run_task_id").notNull().references(() => runTasks.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("passed"),
  message: text("message"),
  url: text("url"),
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




