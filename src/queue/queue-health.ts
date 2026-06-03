import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { jobsTable } from "@/db/schema.js";

/**
 * Operational health of the job queue, derived from the `jobs` table.
 *
 * This exists because the worker once died silently for days while the HTTP
 * server stayed healthy. Expose it at `GET /health/queue` and point an external
 * uptime monitor at it: a non-200 (degraded) response means the queue needs a
 * human (worker not consuming, jobs failing, or a job stuck mid-flight).
 */
export interface QueueHealthThresholds {
  /** A pending job overdue by more than this is "stale" (worker not consuming). */
  pendingMaxAgeSeconds: number;
  /** A `running` job older than this is "stuck" (crashed mid-flight, no reschedule). */
  runningMaxAgeSeconds: number;
  /** Window for counting jobs that exhausted retries and went to `failed`. */
  failedWindowHours: number;
}

export const DEFAULT_QUEUE_HEALTH_THRESHOLDS: QueueHealthThresholds = {
  pendingMaxAgeSeconds: 600,
  runningMaxAgeSeconds: 900,
  failedWindowHours: 24,
};

export interface QueueHealthCheck {
  count: number;
  degraded: boolean;
}

export interface QueueHealth {
  status: "ok" | "degraded";
  generatedAt: string;
  thresholds: QueueHealthThresholds;
  checks: {
    /** Pending jobs whose `available_at` is overdue by more than the threshold. */
    stalePendingJobs: QueueHealthCheck & { oldestPendingAgeSeconds: number };
    /** Jobs that exhausted retries within the window. */
    failedJobs: QueueHealthCheck;
    /** `running` jobs older than the threshold (stuck). */
    stuckRunningJobs: QueueHealthCheck;
  };
}

export interface ComputeQueueHealthInput {
  db: Database;
  now?: Date;
  thresholds?: Partial<QueueHealthThresholds>;
}

const countRows = async (db: Database, whereClause: SQL | undefined): Promise<number> => {
  const rows = await db
    .select({ count: sql<string>`count(*)` })
    .from(jobsTable)
    .where(whereClause);
  return Number(rows[0]?.count ?? 0);
};

export const computeQueueHealth = async (
  input: ComputeQueueHealthInput,
): Promise<QueueHealth> => {
  const thresholds: QueueHealthThresholds = {
    ...DEFAULT_QUEUE_HEALTH_THRESHOLDS,
    ...input.thresholds,
  };
  const now = input.now ?? new Date();
  const staleCutoff = new Date(now.getTime() - thresholds.pendingMaxAgeSeconds * 1000);
  const runningCutoff = new Date(now.getTime() - thresholds.runningMaxAgeSeconds * 1000);
  const failedCutoff = new Date(now.getTime() - thresholds.failedWindowHours * 3600 * 1000);

  const [oldestPendingRows, stalePendingCount, failedCount, stuckRunningCount] = await Promise.all([
    input.db
      .select({ availableAt: jobsTable.availableAt })
      .from(jobsTable)
      .where(and(eq(jobsTable.status, "pending"), lte(jobsTable.availableAt, now)))
      .orderBy(jobsTable.availableAt)
      .limit(1),
    countRows(
      input.db,
      and(eq(jobsTable.status, "pending"), lte(jobsTable.availableAt, staleCutoff)),
    ),
    countRows(
      input.db,
      and(eq(jobsTable.status, "failed"), gte(jobsTable.updatedAt, failedCutoff)),
    ),
    countRows(
      input.db,
      and(eq(jobsTable.status, "running"), lte(jobsTable.updatedAt, runningCutoff)),
    ),
  ]);

  const oldest = oldestPendingRows[0]?.availableAt;
  const oldestPendingAgeSeconds =
    oldest === undefined ? 0 : Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000));

  const checks: QueueHealth["checks"] = {
    stalePendingJobs: {
      count: stalePendingCount,
      oldestPendingAgeSeconds,
      degraded: stalePendingCount > 0,
    },
    failedJobs: { count: failedCount, degraded: failedCount > 0 },
    stuckRunningJobs: { count: stuckRunningCount, degraded: stuckRunningCount > 0 },
  };

  const status = Object.values(checks).some((c) => c.degraded) ? "degraded" : "ok";

  return { status, generatedAt: now.toISOString(), thresholds, checks };
};
