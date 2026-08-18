CREATE TABLE "stack_records" (
	"id" text PRIMARY KEY NOT NULL,
	"stack_id" text NOT NULL,
	"parent_id" text,
	"record_type" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stack_records" ADD CONSTRAINT "stack_records_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stack_records_stack_type_idx" ON "stack_records" USING btree ("stack_id","record_type");--> statement-breakpoint
CREATE INDEX "stack_records_parent_type_idx" ON "stack_records" USING btree ("parent_id","record_type");