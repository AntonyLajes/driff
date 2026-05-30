CREATE TABLE "pushes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo" text NOT NULL,
	"branch" text NOT NULL,
	"before_sha" text NOT NULL,
	"after_sha" text NOT NULL,
	"pusher" text,
	"pushed_at" timestamp with time zone NOT NULL,
	"commit_count" integer NOT NULL,
	"pr_numbers" jsonb NOT NULL,
	"title" text NOT NULL,
	"summary_user_facing" text,
	"summary_technical" text,
	"category" text,
	"area" text,
	"compare_url" text,
	"notion_page_id" text,
	"prompt_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pushes_repo_after_sha_unique" UNIQUE("repo","after_sha")
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "notion_pushes_database_id" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "push_summary_branches" jsonb;
