import { eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { jobsTable } from "@/db/schema.js";

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface QueueJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
}

export interface EnqueueInput {
  type: string;
  payload: Record<string, unknown>;
}

export interface RescheduleInput {
  jobId: string;
  availableAt: Date;
  errorMessage: string;
}

export interface MarkFailedInput {
  jobId: string;
  errorMessage: string;
}

interface DequeueRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
}

export interface ExecuteInput {
  db: Database;
}

export interface QueueAdapter {
  enqueue: (input: EnqueueInput) => Promise<string>;
  dequeue: () => Promise<QueueJob | null>;
  markDone: (jobId: string) => Promise<void>;
  markFailed: (input: MarkFailedInput) => Promise<void>;
  reschedule: (input: RescheduleInput) => Promise<void>;
}

const toQueueJob = (row: DequeueRow): QueueJob => ({
  id: row.id,
  type: row.type,
  payload: row.payload,
  status: row.status,
  attempts: row.attempts,
});

const parseDequeueRow = (row: Record<string, unknown> | undefined): DequeueRow | null => {
  if (!row) {
    return null;
  }

  if (
    typeof row.id !== "string" ||
    typeof row.type !== "string" ||
    typeof row.status !== "string" ||
    typeof row.attempts !== "number" ||
    typeof row.payload !== "object" ||
    row.payload === null ||
    Array.isArray(row.payload)
  ) {
    throw new Error("Invalid row shape returned by dequeue query.");
  }

  return {
    id: row.id,
    type: row.type,
    payload: row.payload as Record<string, unknown>,
    status: row.status as JobStatus,
    attempts: row.attempts,
  };
};

export const execute = ({ db }: ExecuteInput): QueueAdapter => {
  return {
    enqueue: async ({ type, payload }) => {
      const inserted = await db
        .insert(jobsTable)
        .values({
          type,
          payload,
          status: "pending",
        })
        .returning({ id: jobsTable.id });

      const jobId = inserted[0]?.id;
      if (!jobId) {
        throw new Error("Failed to enqueue job.");
      }

      return jobId;
    },
    dequeue: async () => {
      const result = await db.execute(sql<DequeueRow>`
        UPDATE jobs
        SET status = 'running',
            attempts = attempts + 1,
            updated_at = NOW()
        WHERE id = (
          SELECT id
          FROM jobs
          WHERE status = 'pending'
            AND available_at <= NOW()
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, type, payload, status, attempts
      `);

      const row = parseDequeueRow(result[0] as Record<string, unknown> | undefined);
      return row ? toQueueJob(row) : null;
    },
    markDone: async (jobId) => {
      await db
        .update(jobsTable)
        .set({
          status: "done",
          updatedAt: new Date(),
          lastError: null,
        })
        .where(eq(jobsTable.id, jobId));
    },
    markFailed: async ({ jobId, errorMessage }) => {
      await db
        .update(jobsTable)
        .set({
          status: "failed",
          lastError: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(jobsTable.id, jobId));
    },
    reschedule: async ({ jobId, availableAt, errorMessage }) => {
      await db
        .update(jobsTable)
        .set({
          status: "pending",
          availableAt,
          lastError: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(jobsTable.id, jobId));
    },
  };
};
