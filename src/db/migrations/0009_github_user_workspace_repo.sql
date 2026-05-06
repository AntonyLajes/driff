CREATE TABLE "user_github_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"refresh_token_ciphertext" text,
	"scope" text,
	"token_expires_at" timestamp with time zone,
	"github_user_id" text,
	"github_login" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_github_accounts" ADD CONSTRAINT "user_github_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "github_repo_full_name" text;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "github_repo_default_branch" text;
