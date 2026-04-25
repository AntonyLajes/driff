import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client.js";
import { execute } from "@/queue/queue.js";

const buildDbMock = (dequeueRows: Array<Record<string, unknown>> = []) => {
  const returning = vi.fn(async () => [{ id: "job-1" }]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));

  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));

  const executeSql = vi.fn(async () => dequeueRows);

  const db = {
    insert,
    update,
    execute: executeSql,
  } as unknown as Database;

  return {
    db,
    executeSql,
    insert,
    returning,
    set,
    update,
    values,
    where,
  };
};

describe("queue/queue execute", () => {
  it("should enqueue pending job and return id", async () => {
    const { db, values } = buildDbMock();
    const queue = execute({ db });

    const jobId = await queue.enqueue({
      type: "process_pr",
      payload: { repo: "acme/mobile-app", prNumber: 1 },
    });

    expect(jobId).toBe("job-1");
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "process_pr",
        status: "pending",
      }),
    );
  });

  it("should throw when enqueue returns no id", async () => {
    const { db, returning } = buildDbMock();
    returning.mockResolvedValueOnce([]);
    const queue = execute({ db });

    await expect(
      queue.enqueue({
        type: "process_pr",
        payload: { repo: "acme/mobile-app", prNumber: 1 },
      }),
    ).rejects.toThrowError(/Failed to enqueue job/);
  });

  it("should dequeue running job when available", async () => {
    const { db } = buildDbMock([
      {
        id: "job-2",
        type: "process_pr",
        payload: { repo: "acme/mobile-app", prNumber: 2 },
        status: "running",
        attempts: 1,
      },
    ]);
    const queue = execute({ db });

    const job = await queue.dequeue();

    expect(job).toEqual({
      id: "job-2",
      type: "process_pr",
      payload: { repo: "acme/mobile-app", prNumber: 2 },
      status: "running",
      attempts: 1,
    });
  });

  it("should return null when dequeue has no available jobs", async () => {
    const { db } = buildDbMock([]);
    const queue = execute({ db });

    const job = await queue.dequeue();

    expect(job).toBeNull();
  });

  it("should mark done", async () => {
    const { db, set } = buildDbMock();
    const queue = execute({ db });

    await queue.markDone("job-3");

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "done",
      }),
    );
  });

  it("should mark failed", async () => {
    const { db, set } = buildDbMock();
    const queue = execute({ db });

    await queue.markFailed({
      jobId: "job-4",
      errorMessage: "boom",
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        lastError: "boom",
      }),
    );
  });

  it("should reschedule failed job", async () => {
    const { db, set } = buildDbMock();
    const queue = execute({ db });
    const availableAt = new Date("2026-04-25T21:00:00Z");

    await queue.reschedule({
      jobId: "job-5",
      availableAt,
      errorMessage: "temporary failure",
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        availableAt,
        lastError: "temporary failure",
      }),
    );
  });
});
