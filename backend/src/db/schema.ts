import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
});

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
});

export const organizationMemberships = sqliteTable("organization_memberships", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  role: text("role").notNull().default("member"), // 'owner' or 'member'
});

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  terraformVersion: text("terraform_version").default("latest"),
  autoApply: integer("auto_apply", { mode: "boolean" }).default(false),
  locked: integer("locked", { mode: "boolean" }).default(false),
});

export const workspaceVariables = sqliteTable("workspace_variables", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  key: text("key").notNull(),
  value: text("value").notNull(),
  sensitive: integer("sensitive", { mode: "boolean" }).default(false),
  category: text("category").notNull().default("terraform"), // 'terraform' or 'env'
  description: text("description"),
});

export const configurationVersions = sqliteTable("configuration_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  status: text("status").notNull().default("pending"),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  status: text("status").notNull().default("pending"),
  message: text("message"),
});

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(), // The actual token string (e.g. hashed or raw depending on design)
  userId: text("user_id").references(() => users.id), // If it's a user token
  orgId: text("org_id").references(() => organizations.id), // If it's a team/org token
  description: text("description"),
});

export const stateVersions = sqliteTable("state_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  serial: integer("serial").notNull(),
  statePayload: text("state_payload"),
});
