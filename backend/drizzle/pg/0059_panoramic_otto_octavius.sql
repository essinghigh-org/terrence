ALTER TABLE "agents" ADD COLUMN "protocol_version" text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "capabilities" jsonb DEFAULT '["operation.plan","operation.apply","operation.policy","operation.assessment","operation.stack","operation.source-bundle","operation.test","artifact.configuration","artifact.filesystem","artifact.log","artifact.plan-json","artifact.state-json","artifact.atomic-upload","lease.heartbeat","lease.fencing","cancellation","state.publication"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "artifact_formats" jsonb DEFAULT '["tar.gz","json","text"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_version" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_protocol_version" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_execution_policy" jsonb;--> statement-breakpoint
ALTER TABLE "stack_agent_jobs" ADD COLUMN "fencing_token" bigint DEFAULT 0 NOT NULL;