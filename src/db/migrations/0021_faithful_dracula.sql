ALTER TABLE "project_versions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "project_versions" ADD COLUMN "changelog" text;--> statement-breakpoint
ALTER TABLE "project_versions" ADD COLUMN "sections" jsonb;--> statement-breakpoint
ALTER TABLE "project_versions" ADD COLUMN "prompt_version" integer;