CREATE TABLE "ask_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"had_evidence" boolean NOT NULL,
	"feedback" text,
	"feedback_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ask_interactions_feedback_check" CHECK ("ask_interactions"."feedback" IS NULL OR "ask_interactions"."feedback" IN ('helpful', 'unhelpful'))
);
--> statement-breakpoint
ALTER TABLE "ask_interactions" ADD CONSTRAINT "ask_interactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_interactions_workspace_created_at_idx" ON "ask_interactions" USING btree ("workspace_id","created_at");