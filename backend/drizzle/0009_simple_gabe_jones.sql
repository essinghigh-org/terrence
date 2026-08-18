CREATE TABLE `cidr_range_list_agent_pools` (
	`id` text PRIMARY KEY NOT NULL,
	`cidr_range_list_id` text NOT NULL,
	`agent_pool_id` text NOT NULL,
	FOREIGN KEY (`cidr_range_list_id`) REFERENCES `cidr_range_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cidr_range_list_agent_pools_idx` ON `cidr_range_list_agent_pools` (`cidr_range_list_id`,`agent_pool_id`);