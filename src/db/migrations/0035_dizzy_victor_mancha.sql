CREATE TABLE "team_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"target_label" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_audit_events_action_check" CHECK ("team_audit_events"."action" IN ('team_created', 'team_renamed', 'invite_created', 'invite_resent', 'invite_revoked', 'invite_accepted', 'member_role_changed', 'member_removed', 'member_left')),
	CONSTRAINT "team_audit_events_target_type_check" CHECK ("team_audit_events"."target_type" IN ('team', 'invite', 'member'))
);
--> statement-breakpoint
ALTER TABLE "team_audit_events" ADD CONSTRAINT "team_audit_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_audit_events" ADD CONSTRAINT "team_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_audit_events_team_created_at_idx" ON "team_audit_events" USING btree ("team_id","created_at" DESC NULLS LAST);