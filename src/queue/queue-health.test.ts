import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client.js";
import { computeQueueHealth } from "@/queue/queue-health.js";

/**
 * `computeQueueHealth` issues 4 queries via Promise.all, in this order:
 * [oldest-pending, stale-pending-count, failed-count, stuck-running-count].
 * Each `select()` call returns a thenable chain resolving to the next scripted result.
 */
const buildDb = (queue: Array<Array<Record<string, unknown>>>) => {
  let i = 0;
  const select = vi.fn(() => {
    const result = queue[i++] ?? [];
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(result).then(res, rej),
    };
    return chain;
  });
  return { select } as unknown as Database;
};

const NOW = new Date("2026-06-03T12:00:00.000Z");

describe("queue/queue-health computeQueueHealth", () => {
  it("reports ok when nothing is wrong", async () => {
    const db = buildDb([[], [{ count: "0" }], [{ count: "0" }], [{ count: "0" }]]);
    const health = await computeQueueHealth({ db, now: NOW });
    expect(health.status).toBe("ok");
    expect(health.checks.stalePendingJobs.degraded).toBe(false);
    expect(health.checks.failedJobs.degraded).toBe(false);
    expect(health.checks.stuckRunningJobs.degraded).toBe(false);
  });

  it("is degraded when a pending job is overdue past the threshold", async () => {
    const oldAvailableAt = new Date(NOW.getTime() - 1200 * 1000); // 20 min ago
    const db = buildDb([
      [{ availableAt: oldAvailableAt }],
      [{ count: "2" }],
      [{ count: "0" }],
      [{ count: "0" }],
    ]);
    const health = await computeQueueHealth({ db, now: NOW });
    expect(health.status).toBe("degraded");
    expect(health.checks.stalePendingJobs.count).toBe(2);
    expect(health.checks.stalePendingJobs.oldestPendingAgeSeconds).toBe(1200);
    expect(health.checks.stalePendingJobs.degraded).toBe(true);
  });

  it("is degraded when there are failed jobs in the window", async () => {
    const db = buildDb([[], [{ count: "0" }], [{ count: "1" }], [{ count: "0" }]]);
    const health = await computeQueueHealth({ db, now: NOW });
    expect(health.status).toBe("degraded");
    expect(health.checks.failedJobs).toEqual({ count: 1, degraded: true });
  });

  it("is degraded when a running job is stuck", async () => {
    const db = buildDb([[], [{ count: "0" }], [{ count: "0" }], [{ count: "3" }]]);
    const health = await computeQueueHealth({ db, now: NOW });
    expect(health.status).toBe("degraded");
    expect(health.checks.stuckRunningJobs).toEqual({ count: 3, degraded: true });
  });
});
