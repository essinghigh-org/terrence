ALTER TABLE `agents` ADD `protocol_version` text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `capabilities` text DEFAULT '["operation.plan","operation.apply","operation.policy","operation.assessment","operation.stack","operation.source-bundle","operation.test","artifact.configuration","artifact.filesystem","artifact.log","artifact.plan-json","artifact.state-json","artifact.atomic-upload","lease.heartbeat","lease.fencing","cancellation","state.publication"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `artifact_formats` text DEFAULT '["tar.gz","json","text"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `agent_version` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `agent_protocol_version` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `agent_capabilities` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `agent_execution_policy` text;--> statement-breakpoint
ALTER TABLE `stack_agent_jobs` ADD `fencing_token` integer DEFAULT 0 NOT NULL;