CREATE TABLE "cidr_range_list_agent_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"cidr_range_list_id" text NOT NULL,
	"agent_pool_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cidr_range_list_agent_pools" ADD CONSTRAINT "cidr_range_list_agent_pools_cidr_range_list_id_cidr_range_lists_id_fk" FOREIGN KEY ("cidr_range_list_id") REFERENCES "public"."cidr_range_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cidr_range_list_agent_pools" ADD CONSTRAINT "cidr_range_list_agent_pools_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cidr_range_list_agent_pools_idx" ON "cidr_range_list_agent_pools" USING btree ("cidr_range_list_id","agent_pool_id");