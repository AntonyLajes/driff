import { and, count, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import {
  changesTable,
  workspaceDestinationsTable,
  workspacesTable,
} from "@/db/schema.js";
import type { TeamRole } from "@/teams/team-context.js";
import { workspaceVisibilityCondition } from "@/workspaces/member-access.js";

export interface SystemReadiness {
  projects: number;
  searchableProjects: number;
  searchableChanges: number;
  connectedDestinations: number;
  enabledDestinations: number;
  deliveryProjects: number;
}

const emptyReadiness = (): SystemReadiness => ({
  projects: 0,
  searchableProjects: 0,
  searchableChanges: 0,
  connectedDestinations: 0,
  enabledDestinations: 0,
  deliveryProjects: 0,
});

export const execute = async (input: {
  db: Database;
  teamId: string;
  userId: string;
  role: TeamRole;
}): Promise<SystemReadiness> => {
  const workspaces = await input.db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(
      and(
        eq(workspacesTable.teamId, input.teamId),
        workspaceVisibilityCondition({ userId: input.userId, role: input.role }),
      ),
    );
  const workspaceIds = workspaces.map((workspace) => workspace.id);
  if (workspaceIds.length === 0) return emptyReadiness();

  const [changeRows, destinationRows] = await Promise.all([
    input.db
      .select({ workspaceId: changesTable.workspaceId, changes: count() })
      .from(changesTable)
      .where(inArray(changesTable.workspaceId, workspaceIds))
      .groupBy(changesTable.workspaceId),
    input.db
      .select({
        workspaceId: workspaceDestinationsTable.workspaceId,
        enabled: workspaceDestinationsTable.enabled,
        secretCiphertext: workspaceDestinationsTable.secretCiphertext,
      })
      .from(workspaceDestinationsTable)
      .where(inArray(workspaceDestinationsTable.workspaceId, workspaceIds)),
  ]);
  const connected = destinationRows.filter(
    (destination) =>
      destination.secretCiphertext !== null &&
      destination.secretCiphertext.trim().length > 0,
  );
  const enabled = connected.filter((destination) => destination.enabled);

  return {
    projects: workspaceIds.length,
    searchableProjects: changeRows.filter((row) => row.changes > 0).length,
    searchableChanges: changeRows.reduce((total, row) => total + row.changes, 0),
    connectedDestinations: connected.length,
    enabledDestinations: enabled.length,
    deliveryProjects: new Set(enabled.map((destination) => destination.workspaceId)).size,
  };
};
