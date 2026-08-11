CREATE TABLE "change_areas" (
	"change_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"confidence" integer,
	"source" text NOT NULL,
	CONSTRAINT "change_areas_change_id_area_id_pk" PRIMARY KEY("change_id","area_id"),
	CONSTRAINT "change_areas_source_check" CHECK ("change_areas"."source" IN ('rule', 'ai', 'human')),
	CONSTRAINT "change_areas_confidence_check" CHECK ("change_areas"."confidence" IS NULL OR ("change_areas"."confidence" >= 0 AND "change_areas"."confidence" <= 100))
);
--> statement-breakpoint
CREATE TABLE "change_contributors" (
	"change_id" uuid NOT NULL,
	"external_identity" text NOT NULL,
	"display_name" text,
	"role" text NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_contributors_change_id_external_identity_role_pk" PRIMARY KEY("change_id","external_identity","role"),
	CONSTRAINT "change_contributors_role_check" CHECK ("change_contributors"."role" IN ('pr_author', 'commit_author', 'reviewer', 'coauthor'))
);
--> statement-breakpoint
CREATE TABLE "change_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"external_id" text,
	"url" text,
	"sha" text,
	"path" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_record_type" text,
	"source_record_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_evidence_change_source_unique" UNIQUE("change_id","source_key"),
	CONSTRAINT "change_evidence_kind_check" CHECK ("change_evidence"."kind" IN ('pull_request', 'commit', 'file', 'compare', 'release', 'version_marker'))
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_id" uuid,
	"title" text NOT NULL,
	"summary_executive" text,
	"summary_technical" text,
	"category" text NOT NULL,
	"confidence" integer,
	"first_occurred_at" timestamp with time zone NOT NULL,
	"last_occurred_at" timestamp with time zone NOT NULL,
	"prompt_version" integer,
	"corrected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "changes_category_check" CHECK ("changes"."category" IN ('feature', 'bugfix', 'refactor', 'chore', 'other')),
	CONSTRAINT "changes_confidence_check" CHECK ("changes"."confidence" IS NULL OR ("changes"."confidence" >= 0 AND "changes"."confidence" <= 100)),
	CONSTRAINT "changes_occurrence_order_check" CHECK ("changes"."last_occurred_at" >= "changes"."first_occurred_at")
);
--> statement-breakpoint
CREATE TABLE "product_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"rules" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_areas_workspace_slug_unique" UNIQUE("workspace_id","slug")
);
--> statement-breakpoint
CREATE TABLE "project_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_version" text NOT NULL,
	"normalized_version" text NOT NULL,
	"build_version" text,
	"status" text NOT NULL,
	"strategy" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_url" text,
	"before_sha" text,
	"head_sha" text,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_versions_workspace_strategy_source_unique" UNIQUE("workspace_id","strategy","source_ref"),
	CONSTRAINT "project_versions_status_check" CHECK ("project_versions"."status" IN ('released', 'in_development')),
	CONSTRAINT "project_versions_strategy_check" CHECK ("project_versions"."strategy" IN ('github_release', 'git_tag', 'version_file'))
);
--> statement-breakpoint
ALTER TABLE "change_areas" ADD CONSTRAINT "change_areas_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_areas" ADD CONSTRAINT "change_areas_area_id_product_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."product_areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_contributors" ADD CONSTRAINT "change_contributors_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_evidence" ADD CONSTRAINT "change_evidence_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_version_id_project_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."project_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_areas" ADD CONSTRAINT "product_areas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_areas_area_id_idx" ON "change_areas" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "change_contributors_external_identity_idx" ON "change_contributors" USING btree ("external_identity");--> statement-breakpoint
CREATE INDEX "change_evidence_source_key_idx" ON "change_evidence" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "changes_workspace_last_occurred_at_idx" ON "changes" USING btree ("workspace_id","last_occurred_at");--> statement-breakpoint
CREATE INDEX "changes_version_id_idx" ON "changes" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "project_versions_workspace_released_at_idx" ON "project_versions" USING btree ("workspace_id","released_at");