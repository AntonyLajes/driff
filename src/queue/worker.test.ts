import { describe, expect, it, vi } from "vitest";

import { execute } from "@/queue/worker.js";
import type { QueueAdapter, QueueJob } from "@/queue/queue.js";

const buildQueueMock = (dequeueResult: QueueJob | null) => {
  const dequeue = vi.fn(async () => dequeueResult);
  const markDone = vi.fn(async () => undefined);
  const markFailed = vi.fn(async () => undefined);
  const reschedule = vi.fn(async () => undefined);
  const enqueue = vi.fn(async () => "job-id");

  const queue: QueueAdapter = {
    enqueue,
    dequeue,
    markDone,
    markFailed,
    reschedule,
  };

  return { dequeue, markDone, markFailed, queue, reschedule };
};

const buildJob = (attempts = 1): QueueJob => ({
  id: "job-1",
  type: "process_pr",
  payload: { repo: "acme/mobile-app", prNumber: 1 },
  status: "running",
  attempts,
});

describe("queue/worker execute", () => {
  it("should return false when there is no job", async () => {
    const { queue } = buildQueueMock(null);
    const worker = execute({
      queue,
      handlers: {},
      sleeper: async () => undefined,
    });

    const processed = await worker.runOnce();

    expect(processed).toBe(false);
  });

  it("should mark failed when handler is missing", async () => {
    const { markFailed, queue } = buildQueueMock(buildJob());
    const worker = execute({
      queue,
      handlers: {},
      sleeper: async () => undefined,
    });

    const processed = await worker.runOnce();

    expect(processed).toBe(true);
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
      }),
    );
  });

  it("should mark done when handler succeeds", async () => {
    const { markDone, queue, reschedule } = buildQueueMock(buildJob());
    const handler = {
      execute: vi.fn(async () => undefined),
    };
    const worker = execute({
      queue,
      handlers: { process_pr: handler },
      sleeper: async () => undefined,
    });

    await worker.runOnce();

    expect(handler.execute).toHaveBeenCalledWith({
      repo: "acme/mobile-app",
      prNumber: 1,
    });
    expect(markDone).toHaveBeenCalledWith("job-1");
    expect(reschedule).not.toHaveBeenCalled();
  });

  it("should reschedule when handler fails and attempts are below max", async () => {
    const { markFailed, queue, reschedule } = buildQueueMock(buildJob(1));
    const handler = {
      execute: vi.fn(async () => {
        throw new Error("temporary");
      }),
    };
    const worker = execute({
      queue,
      handlers: { process_pr: handler },
      maxAttempts: 3,
      baseRetryDelayMs: 1000,
      sleeper: async () => undefined,
    });

    await worker.runOnce();

    expect(reschedule).toHaveBeenCalledOnce();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("should mark failed when max attempts is reached", async () => {
    const { markFailed, queue, reschedule } = buildQueueMock(buildJob(3));
    const handler = {
      execute: vi.fn(async () => {
        throw new Error("permanent");
      }),
    };
    const worker = execute({
      queue,
      handlers: { process_pr: handler },
      maxAttempts: 3,
      sleeper: async () => undefined,
    });

    await worker.runOnce();

    expect(markFailed).toHaveBeenCalledWith({
      jobId: "job-1",
      errorMessage: "permanent",
    });
    expect(reschedule).not.toHaveBeenCalled();
  });

  it("should run loop and sleep until stopped", async () => {
    const { queue } = buildQueueMock(null);
    const sleeper = vi.fn(async () => {
      worker.stop();
    });
    const worker = execute({
      queue,
      handlers: {},
      pollIntervalMs: 50,
      sleeper,
    });

    await worker.run();

    expect(sleeper).toHaveBeenCalledWith(50);
  });

  it("should fallback to unknown error message on non-error throw", async () => {
    const { markFailed, queue } = buildQueueMock(buildJob(3));
    const handler = {
      execute: vi.fn(async () => {
        throw "bad";
      }),
    };
    const worker = execute({
      queue,
      handlers: { process_pr: handler },
      maxAttempts: 3,
      sleeper: async () => undefined,
    });

    await worker.runOnce();

    expect(markFailed).toHaveBeenCalledWith({
      jobId: "job-1",
      errorMessage: "Unknown worker error.",
    });
  });
});
