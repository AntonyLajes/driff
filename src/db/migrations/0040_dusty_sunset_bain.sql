CREATE TABLE "ask_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ask_conversations_title_length_check" CHECK (char_length("ask_conversations"."title") BETWEEN 1 AND 72),
	CONSTRAINT "ask_conversations_messages_array_check" CHECK (jsonb_typeof("ask_conversations"."messages") = 'array')
);
--> statement-breakpoint
ALTER TABLE "ask_conversations" ADD CONSTRAINT "ask_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_conversations" ADD CONSTRAINT "ask_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_conversations_user_workspace_updated_at_idx" ON "ask_conversations" USING btree ("user_id","workspace_id","updated_at" DESC NULLS LAST);