import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { teamMembersTable, teamsTable } from "@/db/schema.js";

export type TeamRole = "owner" | "admin" | "member";

export const teamRoles = ["owner", "admin", "member"] as const;

export interface TeamContext {
  teamId: string;
  role: TeamRole;
  isPersonal: boolean;
}

export type ResolveTeamContextResult =
  | { kind: "ok"; context: TeamContext }
  | { kind: "invalid_team" }
  | { kind: "not_a_member" };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the acting team from the `x-team-id` request header (if any). */
export const readTeamIdHeader = (
  headers: Record<string, unknown>,
): string | undefined => {
  const value = headers["x-team-id"];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

/**
 * Resolves the acting team for a request. Without an `x-team-id` header the
 * user's PERSONAL team applies — its id equals the user id and the user is
 * always its owner, so no query is needed (also the pre-teams behaviour).
 * An explicit header is validated against the membership table.
 */
export const resolveTeamContext = async (
  db: Database,
  userId: string,
  requestedTeamId: string | undefined,
): Promise<ResolveTeamContextResult> => {
  if (requestedTeamId === undefined || requestedTeamId === userId) {
    return {
      kind: "ok",
      context: { teamId: userId, role: "owner", isPersonal: true },
    };
  }
  if (!uuidPattern.test(requestedTeamId)) {
    return { kind: "invalid_team" };
  }
  const rows = await db
    .select({
      role: teamMembersTable.role,
      isPersonal: teamsTable.isPersonal,
    })
    .from(teamMembersTable)
    .innerJoin(teamsTable, eq(teamsTable.id, teamMembersTable.teamId))
    .where(
      and(
        eq(teamMembersTable.teamId, requestedTeamId),
        eq(teamMembersTable.userId, userId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { kind: "not_a_member" };
  }
  return {
    kind: "ok",
    context: {
      teamId: requestedTeamId,
      role: row.role as TeamRole,
      isPersonal: row.isPersonal,
    },
  };
};
