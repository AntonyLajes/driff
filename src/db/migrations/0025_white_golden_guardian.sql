CREATE TABLE "change_lineage_entries" (
	"lineage_id" uuid NOT NULL,
	"change_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"confidence" integer,
	"corrected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_lineage_entries_lineage_id_change_id_pk" PRIMARY KEY("lineage_id","change_id"),
	CONSTRAINT "change_lineage_entries_relation_type_check" CHECK ("change_lineage_entries"."relation_type" IN ('introduced', 'modified', 'fixed', 'removed', 'restored', 'other')),
	CONSTRAINT "change_lineage_entries_source_check" CHECK ("change_lineage_entries"."source" IN ('rule', 'ai', 'human')),
	CONSTRAINT "change_lineage_entries_confidence_check" CHECK ("change_lineage_entries"."confidence" IS NULL OR ("change_lineage_entries"."confidence" >= 0 AND "change_lineage_entries"."confidence" <= 100))
);
--> statement-breakpoint
CREATE TABLE "change_lineages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text NOT NULL,
	"confidence" integer,
	"merged_into_lineage_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_lineages_workspace_key_unique" UNIQUE("workspace_id","key"),
	CONSTRAINT "change_lineages_status_check" CHECK ("change_lineages"."status" IN ('active', 'removed', 'merged')),
	CONSTRAINT "change_lineages_source_check" CHECK ("change_lineages"."source" IN ('rule', 'ai', 'human')),
	CONSTRAINT "change_lineages_confidence_check" CHECK ("change_lineages"."confidence" IS NULL OR ("change_lineages"."confidence" >= 0 AND "change_lineages"."confidence" <= 100)),
	CONSTRAINT "change_lineages_merged_target_check" CHECK (("change_lineages"."status" = 'merged' AND "change_lineages"."merged_into_lineage_id" IS NOT NULL) OR ("change_lineages"."status" <> 'merged' AND "change_lineages"."merged_into_lineage_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "change_lineage_entries" ADD CONSTRAINT "change_lineage_entries_lineage_id_change_lineages_id_fk" FOREIGN KEY ("lineage_id") REFERENCES "public"."change_lineages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_lineage_entries" ADD CONSTRAINT "change_lineage_entries_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_lineages" ADD CONSTRAINT "change_lineages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_lineages" ADD CONSTRAINT "change_lineages_merged_into_lineage_id_fk" FOREIGN KEY ("merged_into_lineage_id") REFERENCES "public"."change_lineages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_lineage_entries_lineage_timeline_idx" ON "change_lineage_entries" USING btree ("lineage_id","occurred_at","change_id");--> statement-breakpoint
CREATE INDEX "change_lineage_entries_change_id_idx" ON "change_lineage_entries" USING btree ("change_id");--> statement-breakpoint
CREATE INDEX "change_lineages_workspace_status_updated_idx" ON "change_lineages" USING btree ("workspace_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "change_lineages_merged_into_lineage_id_idx" ON "change_lineages" USING btree ("merged_into_lineage_id");