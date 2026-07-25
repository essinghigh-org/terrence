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

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  terraformVersion: text("terraform_version").default("latest"),
  autoApply: integer("auto_apply", { mode: "boolean" }).default(false),
  locked: integer("locked", { mode: "boolean" }).default(false),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  status: text("status").notNull().default("pending"),
  message: text("message"),
});

export const stateVersions = sqliteTable("state_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  serial: integer("serial").notNull(),
  statePayload: text("state_payload"),
});
