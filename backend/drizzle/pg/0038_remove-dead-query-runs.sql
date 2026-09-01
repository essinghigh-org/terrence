DROP TABLE "query_runs" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "fencing_token" bigint DEFAULT 0 NOT NULL;