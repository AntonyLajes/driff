import type { Database } from "@/db/client.js";
import { teamAuditEventsTable } from "@/db/schema.js";

export interface TeamAuditEventInput {
  teamId: string;
  actorUserId: string | null;
  action:
    | "team_created"
    | "team_renamed"
    | "invite_created"
    | "invite_resent"
    | "invite_revoked"
    | "invite_accepted"
    | "member_role_changed"
    | "member_removed"
    | "member_left";
  targetType: "team" | "invite" | "member";
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown>;
}

export type TeamAuditRecorder = (event: TeamAuditEventInput) => Promise<void>;

export const execute =
  ({ db }: { db: Database }): TeamAuditRecorder =>
  async (event) => {
    await db.insert(teamAuditEventsTable).values({
      teamId: event.teamId,
      actorUserId: event.actorUserId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId ?? null,
      targetLabel: event.targetLabel ?? null,
      metadata: event.metadata ?? {},
    });
  };
