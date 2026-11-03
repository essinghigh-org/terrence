ALTER TABLE `registry_modules` ADD `ingress_submodules` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `stacks` ADD `vcs_ingress_submodules` integer DEFAULT false NOT NULL;