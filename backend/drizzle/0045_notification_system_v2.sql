DROP TABLE IF EXISTS notification_configurations;
--> statement-breakpoint
-- Notification system v2: replaces legacy notification_configurations.
-- Org-scoped destinations, templates, rules, and a delivery log. The old
-- table is dropped; nothing in the running system references it after the
-- v2 code lands (worker emitters now go through lib/notify.ts).
CREATE TABLE IF NOT EXISTS notification_destinations (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_templates (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_rules (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  workspace_tag_filters TEXT NOT NULL DEFAULT '[]',
  destination_id TEXT NOT NULL REFERENCES notification_destinations(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES notification_templates(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  rule_id TEXT REFERENCES notification_rules(id) ON DELETE SET NULL,
  destination_id TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  successful INTEGER NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_deliveries_org_idx ON notification_deliveries(org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_deliveries_ws_idx ON notification_deliveries(workspace_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_rules_org_idx ON notification_rules(org_id);
