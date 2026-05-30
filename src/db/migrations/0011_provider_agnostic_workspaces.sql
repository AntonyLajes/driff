ALTER TABLE "workspaces" RENAME COLUMN "github_repo_full_name" TO "repo_full_name";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME COLUMN "github_repo_default_branch" TO "repo_default_branch";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "source_provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_provider_repo_unique" ON "workspaces" USING btree ("source_provider","repo_full_name") WHERE "workspaces"."repo_full_name" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "user_github_accounts" RENAME TO "user_source_connections";--> statement-breakpoint
ALTER TABLE "user_source_connections" RENAME COLUMN "github_user_id" TO "external_account_id";--> statement-breakpoint
ALTER TABLE "user_source_connections" RENAME COLUMN "github_login" TO "external_login";--> statement-breakpoint
ALTER TABLE "user_source_connections" RENAME CONSTRAINT "user_github_accounts_user_id_users_id_fk" TO "user_source_connections_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_source_connections" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_source_connections" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user_source_connections" DROP CONSTRAINT "user_github_accounts_pkey";--> statement-breakpoint
ALTER TABLE "user_source_connections" ADD CONSTRAINT "user_source_connections_user_id_provider_pk" PRIMARY KEY("user_id","provider");
