-- Read-path performance indexes:
--   1) runs(workspace_id, created_at) — org runs list, latest-run-per-workspace
--      lookups, and the workspaces current-run filter all filter/order by
--      workspace then created_at. Without this the runs list scans the whole
--      table.
--   2) team_memberships(user_id) — permission calculation resolves a user's
--      teams by user_id; the (team_id, user_id) unique index cannot serve a
--      user_id-first lookup, so every workspace/detail request scanned it.
--   3) organization_memberships(user_id, org_id) — checkOrgPermission/
--      checkOrganizationPermission look up a user's membership in an org by
--      (user_id, org_id); there was no index, so every owner/member probe
--      scanned the table.
CREATE INDEX IF NOT EXISTS runs_workspace_created_idx ON `runs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS team_memberships_user_idx ON `team_memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS organization_memberships_user_org_idx ON `organization_memberships` (`user_id`,`org_id`);