ALTER TABLE `projects` ADD `is_default` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `projects`
SET `is_default` = 1
WHERE `name` = 'Default Project';
--> statement-breakpoint
INSERT INTO `projects` (
  `id`,
  `org_id`,
  `name`,
  `description`,
  `default_execution_mode`,
  `setting_overwrites`,
  `is_default`,
  `created_at`
)
SELECT
  'prj-' || lower(hex(randomblob(16))),
  `organizations`.`id`,
  'Default Project',
  'Default Project for Organization',
  'remote',
  '{"execution-mode":false}',
  1,
  CAST(strftime('%s', 'now') AS integer) * 1000
FROM `organizations`
WHERE NOT EXISTS (
  SELECT 1
  FROM `projects`
  WHERE `projects`.`org_id` = `organizations`.`id`
    AND `projects`.`is_default` = 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_default_idx`
ON `projects` (`org_id`)
WHERE `is_default` = 1;
--> statement-breakpoint
UPDATE `projects`
SET `setting_overwrites` = '{"execution-mode":false}'
WHERE `setting_overwrites` IS NULL;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `execution_mode` text DEFAULT 'remote' NOT NULL;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `inherits_project_auto_destroy` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `workspaces`
SET `project_id` = (
  SELECT `projects`.`id`
  FROM `projects`
  WHERE `projects`.`org_id` = `workspaces`.`org_id`
    AND `projects`.`is_default` = 1
)
WHERE `project_id` IS NULL;
--> statement-breakpoint
UPDATE `workspaces`
SET
  `execution_mode` = COALESCE((
    SELECT `projects`.`default_execution_mode`
    FROM `projects`
    WHERE `projects`.`id` = `workspaces`.`project_id`
  ), 'remote'),
  `agent_pool_id` = (
    SELECT `projects`.`default_agent_pool_id`
    FROM `projects`
    WHERE `projects`.`id` = `workspaces`.`project_id`
  )
WHERE COALESCE(json_extract(`setting_overwrites`, '$."execution-mode"'), 0) = 0;
--> statement-breakpoint
UPDATE `workspaces`
SET
  `auto_destroy_activity_duration` = (
    SELECT `projects`.`auto_destroy_activity_duration`
    FROM `projects`
    WHERE `projects`.`id` = `workspaces`.`project_id`
  ),
  `inherits_project_auto_destroy` = 1
WHERE `auto_destroy_activity_duration` IS NULL;
--> statement-breakpoint
UPDATE `workspaces`
SET `setting_overwrites` = '{"execution-mode":false,"agent-pool":false}'
WHERE `setting_overwrites` IS NULL;
