CREATE TABLE "history_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"period_months" integer DEFAULT 12 NOT NULL,
	"max_pull_requests" integer DEFAULT 100 NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"processed_items" integer DEFAULT 0 NOT NULL,
	"failed_items" integer DEFAULT 0 NOT NULL,
	"completed_pr_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "history_imports_status_check" CHECK ("history_imports"."status" IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled')),
	CONSTRAINT "history_imports_period_months_check" CHECK ("history_imports"."period_months" BETWEEN 1 AND 24),
	CONSTRAINT "history_imports_max_pull_requests_check" CHECK ("history_imports"."max_pull_requests" BETWEEN 10 AND 200)
);
--> statement-breakpoint
ALTER TABLE "history_imports" ADD CONSTRAINT "history_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_imports" ADD CONSTRAINT "history_imports_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "history_imports_workspace_created_at_idx" ON "history_imports" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "history_imports_active_workspace_unique" ON "history_imports" USING btree ("workspace_id") WHERE "history_imports"."status" IN ('pending', 'running');