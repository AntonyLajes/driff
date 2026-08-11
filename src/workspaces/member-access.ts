import { sql, type SQL } from "drizzle-orm";

import { workspaceMemberAccessTable, workspacesTable } from "@/db/schema.js";
import type { TeamRole } from "@/teams/team-context.js";

export type WorkspaceMemberAccessMode = "all" | "restricted";

/**
 * Owners and admins can always read every project in their team. Regular
 * members can read projects shared with everyone or explicitly granted to
 * them. Keeping this as a SQL predicate prevents hidden projects from leaking
 * through list, detail and aggregate endpoints.
 */
export const workspaceVisibilityCondition = (input: {
  userId: string;
  role: TeamRole;
}): SQL =>
  input.role !== "member"
    ? sql`true`
    : sql`(
        ${workspacesTable.memberAccess} = 'all'
        OR EXISTS (
          SELECT 1
          FROM ${workspaceMemberAccessTable}
          WHERE ${workspaceMemberAccessTable.workspaceId} = ${workspacesTable.id}
            AND ${workspaceMemberAccessTable.userId} = ${input.userId}
        )
      )`;
