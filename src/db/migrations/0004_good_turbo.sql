CREATE TABLE "workspace_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notion_pr_database_id" text,
	"notion_releases_database_id" text,
	"release_info_plist_path" text,
	"release_version_branch" text,
	"release_monitored_repo" text,
	"release_project_pbxproj_path" text,
	"release_compare_root_sha" text,
	"pr_summary_base_branches" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
