CREATE TABLE "summary_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_record_type" text NOT NULL,
	"source_record_id" uuid NOT NULL,
	"edited_by_user_id" uuid NOT NULL,
	"before_user_facing" text,
	"before_technical" text,
	"after_user_facing" text NOT NULL,
	"after_technical" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "summary_corrections" ADD CONSTRAINT "summary_corrections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_corrections" ADD CONSTRAINT "summary_corrections_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "summary_corrections_record_created_at_idx" ON "summary_corrections" USING btree ("source_record_type","source_record_id","created_at");--> statement-breakpoint
CREATE INDEX "summary_corrections_workspace_created_at_idx" ON "summary_corrections" USING btree ("workspace_id","created_at");