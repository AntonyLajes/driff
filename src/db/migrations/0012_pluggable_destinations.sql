CREATE TABLE "workspace_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb,
	"secret_ciphertext" text,
	"external_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_destinations_workspace_id_type_unique" UNIQUE("workspace_id","type")
);
--> statement-breakpoint
ALTER TABLE "workspace_destinations" ADD CONSTRAINT "workspace_destinations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_destinations_workspace_id_idx" ON "workspace_destinations" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "notion_pr_database_id";--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "notion_releases_database_id";--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "notion_pushes_database_id";
