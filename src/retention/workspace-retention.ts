import { and, count, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client.js";
import {
  jobsTable,
  webhookEventsTable,
  workspaceSettingsTable,
  workspacesTable,
} from "@/db/schema.js";

export const sourceDataRetentionDaysSchema = z.union([
  z.literal(30),
  z.literal(90),
  z.literal(180),
  z.literal(365),
]);

export type SourceDataRetentionDays = z.infer<
  typeof sourceDataRetentionDaysSchema
>;

const DAY_MS = 86_400_000;

export interface WorkspaceRetentionPreview {
  retentionDays: SourceDataRetentionDays | null;
  cutoff: Date | null;
  rawWebhookEvents: number;
  finishedJobs: number;
  totalRecords: number;
}

const workspaceJobCondition = (workspaceId: string, repo: string) => {
  const byWorkspace = sql`${jobsTable.payload}->>'workspaceId' = ${workspaceId}`;
  const byRepo =
    repo.length > 0 ? sql`${jobsTable.payload}->>'repo' = ${repo}` : undefined;
  return byRepo === undefined ? byWorkspace : or(byWorkspace, byRepo);
};

const oldWebhookCondition = (repo: string, cutoff: Date) =>
  and(
    sql`${webhookEventsTable.payload}->'repository'->>'full_name' = ${repo}`,
    lt(webhookEventsTable.receivedAt, cutoff),
    // Keep the newest event so Diagnostics can still confirm that this
    // repository has reached the webhook boundary even after an idle period.
    sql`${webhookEventsTable.id} NOT IN (
      SELECT ${webhookEventsTable.id}
      FROM ${webhookEventsTable}
      WHERE ${webhookEventsTable.payload}->'repository'->>'full_name' = ${repo}
      ORDER BY ${webhookEventsTable.receivedAt} DESC
      LIMIT 1
    )`,
  );

const oldFinishedJobCondition = (
  workspaceId: string,
  repo: string,
  cutoff: Date,
) =>
  and(
    workspaceJobCondition(workspaceId, repo),
    inArray(jobsTable.status, ["done", "failed"]),
    lt(jobsTable.updatedAt, cutoff),
  );

export const loadWorkspaceRetentionPreview = async (input: {
  db: Database;
  workspaceId: string;
  repoFullName: string | null;
  retentionDays: SourceDataRetentionDays | null;
  now?: Date;
}): Promise<WorkspaceRetentionPreview> => {
  if (input.retentionDays === null) {
    return {
      retentionDays: null,
      cutoff: null,
      rawWebhookEvents: 0,
      finishedJobs: 0,
      totalRecords: 0,
    };
  }
  const cutoff = new Date(
    (input.now ?? new Date()).getTime() - input.retentionDays * DAY_MS,
  );
  const repo = input.repoFullName?.trim() ?? "";
  const webhookPromise =
    repo.length === 0
      ? Promise.resolve([{ value: 0 }])
      : input.db
          .select({ value: count() })
          .from(webhookEventsTable)
          .where(oldWebhookCondition(repo, cutoff));
  const [webhookRows, jobRows] = await Promise.all([
    webhookPromise,
    input.db
      .select({ value: count() })
      .from(jobsTable)
      .where(oldFinishedJobCondition(input.workspaceId, repo, cutoff)),
  ]);
  const rawWebhookEvents = webhookRows[0]?.value ?? 0;
  const finishedJobs = jobRows[0]?.value ?? 0;
  return {
    retentionDays: input.retentionDays,
    cutoff,
    rawWebhookEvents,
    finishedJobs,
    totalRecords: rawWebhookEvents + finishedJobs,
  };
};

export const scheduleWorkspaceRetention = async (input: {
  db: Database;
  workspaceId: string;
  retentionDays: SourceDataRetentionDays | null;
  availableAt?: Date;
}): Promise<void> => {
  await input.db
    .delete(jobsTable)
    .where(
      and(
        eq(jobsTable.type, "apply_retention"),
        eq(jobsTable.status, "pending"),
        sql`${jobsTable.payload}->>'workspaceId' = ${input.workspaceId}`,
      ),
    );
  if (input.retentionDays === null) return;
  await input.db.insert(jobsTable).values({
    type: "apply_retention",
    payload: { workspaceId: input.workspaceId },
    status: "pending",
    availableAt: input.availableAt ?? new Date(),
  });
};

/** Applies one opted-in workspace policy and schedules its next daily sweep. */
export const applyWorkspaceRetention = async (input: {
  db: Database;
  workspaceId: string;
  now?: Date;
}): Promise<WorkspaceRetentionPreview> => {
  const rows = await input.db
    .select({
      repoFullName: workspacesTable.repoFullName,
      retentionDays: workspaceSettingsTable.sourceDataRetentionDays,
    })
    .from(workspacesTable)
    .innerJoin(
      workspaceSettingsTable,
      eq(workspaceSettingsTable.workspaceId, workspacesTable.id),
    )
    .where(eq(workspacesTable.id, input.workspaceId))
    .limit(1);
  const row = rows[0];
  const parsedDays = sourceDataRetentionDaysSchema.safeParse(
    row?.retentionDays,
  );
  if (row === undefined || !parsedDays.success) {
    return {
      retentionDays: null,
      cutoff: null,
      rawWebhookEvents: 0,
      finishedJobs: 0,
      totalRecords: 0,
    };
  }
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - parsedDays.data * DAY_MS);
  const repo = row.repoFullName?.trim() ?? "";

  const deleted = await input.db.transaction(async (transaction) => {
    const webhookRows =
      repo.length === 0
        ? []
        : await transaction
            .delete(webhookEventsTable)
            .where(oldWebhookCondition(repo, cutoff))
            .returning({ id: webhookEventsTable.id });
    const jobRows = await transaction
      .delete(jobsTable)
      .where(oldFinishedJobCondition(input.workspaceId, repo, cutoff))
      .returning({ id: jobsTable.id });
    await transaction
      .update(workspaceSettingsTable)
      .set({ retentionLastRunAt: now, updatedAt: now })
      .where(eq(workspaceSettingsTable.workspaceId, input.workspaceId));
    return {
      rawWebhookEvents: webhookRows.length,
      finishedJobs: jobRows.length,
    };
  });

  await scheduleWorkspaceRetention({
    db: input.db,
    workspaceId: input.workspaceId,
    retentionDays: parsedDays.data,
    availableAt: new Date(now.getTime() + DAY_MS),
  });
  return {
    retentionDays: parsedDays.data,
    cutoff,
    ...deleted,
    totalRecords: deleted.rawWebhookEvents + deleted.finishedJobs,
  };
};

export const createWorkspaceRetentionJob = (input: { db: Database }) => ({
  execute: async (payload: Record<string, unknown>): Promise<void> => {
    const parsed = z
      .object({ workspaceId: z.string().uuid() })
      .safeParse(payload);
    if (!parsed.success) throw new Error("Invalid apply_retention payload.");
    await applyWorkspaceRetention({
      db: input.db,
      workspaceId: parsed.data.workspaceId,
    });
  },
});
