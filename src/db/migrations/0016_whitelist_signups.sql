CREATE TABLE "whitelist_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"team" text NOT NULL,
	"team_size" text,
	"role" text,
	"github_org" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whitelist_signups_email_unique" UNIQUE("email")
);
