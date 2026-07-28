ALTER TABLE `oauth_clients` ADD `agent_pool_id` text REFERENCES `agent_pools`(`id`) ON DELETE SET NULL;
