CREATE TABLE "workspace_member_access" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_member_access_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "member_access" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_member_access" ADD CONSTRAINT "workspace_member_access_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member_access" ADD CONSTRAINT "workspace_member_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member_access" ADD CONSTRAINT "workspace_member_access_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_member_access_user_id_idx" ON "workspace_member_access" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_member_access_check" CHECK ("workspaces"."member_access" IN ('all', 'restricted'));