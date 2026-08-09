import { and, desc, eq } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { historyImportsTable, type HistoryImportFailure } from "@/db/schema.js";

export type HistoryImportStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export interface HistoryImportRecord {
  id: string;
  workspaceId: string;
  requestedByUserId: string;
  status: HistoryImportStatus;
  periodMonths: number;
  maxPullRequests: number;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  completedPrNumbers: number[];
  failures: HistoryImportFailure[];
  truncated: boolean;
  cancelRequested: boolean;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const recordSelection = {
  id: historyImportsTable.id,
  workspaceId: historyImportsTable.workspaceId,
  requestedByUserId: historyImportsTable.requestedByUserId,
  status: historyImportsTable.status,
  periodMonths: historyImportsTable.periodMonths,
  maxPullRequests: historyImportsTable.maxPullRequests,
  totalItems: historyImportsTable.totalItems,
  processedItems: historyImportsTable.processedItems,
  failedItems: historyImportsTable.failedItems,
  completedPrNumbers: historyImportsTable.completedPrNumbers,
  failures: historyImportsTable.failures,
  truncated: historyImportsTable.truncated,
  cancelRequested: historyImportsTable.cancelRequested,
  lastError: historyImportsTable.lastError,
  startedAt: historyImportsTable.startedAt,
  completedAt: historyImportsTable.completedAt,
  createdAt: historyImportsTable.createdAt,
  updatedAt: historyImportsTable.updatedAt,
};

const toRecord = (
  row: typeof historyImportsTable.$inferSelect,
): HistoryImportRecord => ({
  ...row,
  status: row.status as HistoryImportStatus,
});

export interface ExecuteInput {
  db: Database;
}

export const execute = ({ db }: ExecuteInput) => ({
  create: async (input: {
    workspaceId: string;
    requestedByUserId: string;
    periodMonths: number;
    maxPullRequests: number;
  }): Promise<HistoryImportRecord> => {
    const rows = await db
      .insert(historyImportsTable)
      .values(input)
      .returning(recordSelection);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("History import insert returned no row.");
    }
    return toRecord(row as typeof historyImportsTable.$inferSelect);
  },
  findById: async (id: string): Promise<HistoryImportRecord | null> => {
    const rows = await db
      .select(recordSelection)
      .from(historyImportsTable)
      .where(eq(historyImportsTable.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : toRecord(row as typeof historyImportsTable.$inferSelect);
  },
  findLatestForWorkspace: async (
    workspaceId: string,
  ): Promise<HistoryImportRecord | null> => {
    const rows = await db
      .select(recordSelection)
      .from(historyImportsTable)
      .where(eq(historyImportsTable.workspaceId, workspaceId))
      .orderBy(desc(historyImportsTable.createdAt))
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : toRecord(row as typeof historyImportsTable.$inferSelect);
  },
  markRunning: async (id: string, startedAt: Date): Promise<void> => {
    await db
      .update(historyImportsTable)
      .set({
        status: "running",
        startedAt,
        completedAt: null,
        lastError: null,
        failures: [],
        failedItems: 0,
        updatedAt: startedAt,
      })
      .where(eq(historyImportsTable.id, id));
  },
  markDiscovered: async (input: {
    id: string;
    totalItems: number;
    truncated: boolean;
    updatedAt: Date;
  }): Promise<void> => {
    await db
      .update(historyImportsTable)
      .set({
        totalItems: input.totalItems,
        truncated: input.truncated,
        updatedAt: input.updatedAt,
      })
      .where(eq(historyImportsTable.id, input.id));
  },
  isCancellationRequested: async (id: string): Promise<boolean> => {
    const rows = await db
      .select({ cancelRequested: historyImportsTable.cancelRequested })
      .from(historyImportsTable)
      .where(eq(historyImportsTable.id, id))
      .limit(1);
    return rows[0]?.cancelRequested ?? true;
  },
  updateProgress: async (input: {
    id: string;
    completedPrNumbers: number[];
    failures: HistoryImportFailure[];
    updatedAt: Date;
  }): Promise<void> => {
    await db
      .update(historyImportsTable)
      .set({
        completedPrNumbers: input.completedPrNumbers,
        failures: input.failures,
        processedItems: input.completedPrNumbers.length + input.failures.length,
        failedItems: input.failures.length,
        updatedAt: input.updatedAt,
      })
      .where(eq(historyImportsTable.id, input.id));
  },
  markTerminal: async (input: {
    id: string;
    status: Extract<HistoryImportStatus, "completed" | "partial" | "cancelled">;
    completedAt: Date;
  }): Promise<void> => {
    await db
      .update(historyImportsTable)
      .set({
        status: input.status,
        completedAt: input.completedAt,
        updatedAt: input.completedAt,
      })
      .where(eq(historyImportsTable.id, input.id));
  },
  markFailed: async (input: {
    id: string;
    message: string;
    updatedAt: Date;
  }): Promise<void> => {
    await db
      .update(historyImportsTable)
      .set({
        status: "failed",
        lastError: input.message,
        updatedAt: input.updatedAt,
      })
      .where(eq(historyImportsTable.id, input.id));
  },
  requestCancellation: async (
    workspaceId: string,
    id: string,
    updatedAt: Date,
  ): Promise<boolean> => {
    const rows = await db
      .update(historyImportsTable)
      .set({ cancelRequested: true, updatedAt })
      .where(
        and(
          eq(historyImportsTable.id, id),
          eq(historyImportsTable.workspaceId, workspaceId),
        ),
      )
      .returning({ id: historyImportsTable.id });
    return rows.length > 0;
  },
});

export type HistoryImportRepository = ReturnType<typeof execute>;
