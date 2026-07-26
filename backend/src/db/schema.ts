import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email"),
  passwordHash: text("password_hash").notNull(),
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
});

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  iacBinary: text("iac_binary"), // null inherits from org
  terraformVersion: text("terraform_version").default("latest"),
  workingDirectory: text("working_directory"),
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
  autoApply: integer("auto_apply", { mode: "boolean" }).default(false),
  locked: integer("locked", { mode: "boolean" }).default(false),
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
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  configurationVersionId: text("configuration_version_id").references(() => configurationVersions.id, { onDelete: "cascade" }),
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
  logToken: text("log_token"),
  terraformVersion: text("terraform_version"),
  debuggingMode: integer("debugging_mode", { mode: "boolean" }).notNull().default(false),
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
});

export const variableSetWorkspaces = sqliteTable("variable_set_workspaces", {
  id: text("id").primaryKey(),
  variableSetId: text("variable_set_id").notNull().references(() => variableSets.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("variable_set_workspaces_idx").on(table.variableSetId, table.workspaceId),
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
