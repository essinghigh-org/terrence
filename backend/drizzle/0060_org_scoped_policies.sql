-- Org-scoped (standalone) policies for go-tfe Policies.Create parity.
-- Adds policies.org_id; making policy_set_id nullable requires a table
-- rebuild, which is applied idempotently in the db/index.ts startup
-- compatibility block (SQLite cannot drop NOT NULL with ALTER). Fresh DBs get
-- org_id here; the startup block then rebuilds for nullable + backfills org_id
-- from each policy's policy set.
ALTER TABLE `policies` ADD COLUMN `org_id` text REFERENCES `organizations`(`id`) ON DELETE cascade;