import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  jobsTable,
  llmUsageTable,
  pullRequestsTable,
  pushesTable,
  releasesTable,
  webhookEventsTable,
  workspacesTable,
} from "@/db/schema.js";
import { execute } from "@/workspaces/delete-workspace-data.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000aa";
const TEAM_ID = "00000000-0000-4000-8000-0000000000bb";

const buildDatabase = () => {
  const deletedTables: string[] = [];
  const where = vi.fn(async () => undefined);
  const transaction = {
    delete: vi.fn((table: Parameters<typeof getTableName>[0]) => {
      deletedTables.push(getTableName(table));
      return { where };
    }),
  };
  const db = {
    transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<void>) =>
      callback(transaction),
    ),
  };
  return { db, deletedTables, where };
};

describe("workspaces/delete-workspace-data", () => {
  it("should delete all repo-keyed and workspace-scoped records atomically", async () => {
    const { db, deletedTables, where } = buildDatabase();

    await execute({
      db: db as never,
      workspaceId: WORKSPACE_ID,
      teamId: TEAM_ID,
      repoFullName: " AntonyLajes/ride-pack ",
    });

    expect(deletedTables).toEqual([
      getTableName(jobsTable),
      getTableName(webhookEventsTable),
      getTableName(pullRequestsTable),
      getTableName(releasesTable),
      getTableName(pushesTable),
      getTableName(llmUsageTable),
      getTableName(workspacesTable),
    ]);
    expect(where).toHaveBeenCalledTimes(7);
    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it("should still delete workspace jobs when no repository is linked", async () => {
    const { db, deletedTables, where } = buildDatabase();

    await execute({
      db: db as never,
      workspaceId: WORKSPACE_ID,
      teamId: TEAM_ID,
      repoFullName: null,
    });

    expect(deletedTables).toEqual([
      getTableName(jobsTable),
      getTableName(workspacesTable),
    ]);
    expect(where).toHaveBeenCalledTimes(2);
  });
});
