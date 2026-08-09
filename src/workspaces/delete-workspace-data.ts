import { and, eq, or, sql } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import {
  jobsTable,
  llmUsageTable,
  pullRequestsTable,
  pushesTable,
  releasesTable,
  webhookEventsTable,
  workspacesTable,
} from "@/db/schema.js";

export interface DeleteWorkspaceDataInput {
  db: Database;
  workspaceId: string;
  teamId: string;
  repoFullName: string | null;
}

/**
 * Permanently removes a workspace and every repo-keyed record that cannot rely
 * on the workspace foreign-key cascade.
 */
export const execute = async (input: DeleteWorkspaceDataInput): Promise<void> => {
  const repo = input.repoFullName?.trim() ?? "";

  await input.db.transaction(async (transaction) => {
    const workspaceJob = sql`${jobsTable.payload}->>'workspaceId' = ${input.workspaceId}`;
    const repoJob =
      repo.length > 0 ? sql`${jobsTable.payload}->>'repo' = ${repo}` : undefined;

    await transaction
      .delete(jobsTable)
      .where(repoJob === undefined ? workspaceJob : or(workspaceJob, repoJob));

    if (repo.length > 0) {
      await transaction
        .delete(webhookEventsTable)
        .where(sql`${webhookEventsTable.payload}->'repository'->>'full_name' = ${repo}`);
      await transaction.delete(pullRequestsTable).where(eq(pullRequestsTable.repo, repo));
      await transaction.delete(releasesTable).where(eq(releasesTable.repo, repo));
      await transaction.delete(pushesTable).where(eq(pushesTable.repo, repo));
      await transaction.delete(llmUsageTable).where(eq(llmUsageTable.repo, repo));
    }

    // All workspace-scoped derived data, settings, destinations and audit rows
    // are removed by their ON DELETE CASCADE constraints.
    await transaction
      .delete(workspacesTable)
      .where(
        and(
          eq(workspacesTable.id, input.workspaceId),
          eq(workspacesTable.teamId, input.teamId),
        ),
      );
  });
};
