import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import {
  askInteractionsTable,
  historyImportsTable,
  workspacesTable,
} from "@/db/schema.js";

export interface ProductFunnel {
  connectedProjects: number;
  historyReadyProjects: number;
  askedProjects: number;
  evidenceAnswerProjects: number;
  helpfulFeedback: number;
  unhelpfulFeedback: number;
}

const emptyFunnel = (): ProductFunnel => ({
  connectedProjects: 0,
  historyReadyProjects: 0,
  askedProjects: 0,
  evidenceAnswerProjects: 0,
  helpfulFeedback: 0,
  unhelpfulFeedback: 0,
});

export const execute = async (input: {
  db: Database;
  teamId: string;
}): Promise<ProductFunnel> => {
  const workspaceRows = await input.db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.teamId, input.teamId));
  const workspaceIds = workspaceRows.map((row) => row.id);
  if (workspaceIds.length === 0) return emptyFunnel();

  const [historyRows, interactionRows] = await Promise.all([
    input.db
      .select({ workspaceId: historyImportsTable.workspaceId })
      .from(historyImportsTable)
      .where(
        and(
          inArray(historyImportsTable.workspaceId, workspaceIds),
          inArray(historyImportsTable.status, ["completed", "partial"]),
        ),
      )
      .groupBy(historyImportsTable.workspaceId),
    input.db
      .select({
        workspaceId: askInteractionsTable.workspaceId,
        evidenceAnswers:
          sql<number>`count(*) filter (where ${askInteractionsTable.hadEvidence})`.mapWith(
            Number,
          ),
        helpfulFeedback:
          sql<number>`count(*) filter (where ${askInteractionsTable.feedback} = 'helpful')`.mapWith(
            Number,
          ),
        unhelpfulFeedback:
          sql<number>`count(*) filter (where ${askInteractionsTable.feedback} = 'unhelpful')`.mapWith(
            Number,
          ),
      })
      .from(askInteractionsTable)
      .where(inArray(askInteractionsTable.workspaceId, workspaceIds))
      .groupBy(askInteractionsTable.workspaceId),
  ]);

  return {
    connectedProjects: workspaceIds.length,
    historyReadyProjects: historyRows.length,
    askedProjects: interactionRows.length,
    evidenceAnswerProjects: interactionRows.filter((row) => row.evidenceAnswers > 0).length,
    helpfulFeedback: interactionRows.reduce(
      (total, row) => total + row.helpfulFeedback,
      0,
    ),
    unhelpfulFeedback: interactionRows.reduce(
      (total, row) => total + row.unhelpfulFeedback,
      0,
    ),
  };
};
