import type { QueueAdapter } from "@/queue/queue.js";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_RETRY_DELAY_MS = 60_000;

export interface JobHandler {
  execute: (payload: Record<string, unknown>) => Promise<void>;
}

export interface ExecuteInput {
  queue: QueueAdapter;
  handlers: Record<string, JobHandler>;
  pollIntervalMs?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  sleeper?: (durationMs: number) => Promise<void>;
}

export interface WorkerAdapter {
  runOnce: () => Promise<boolean>;
  run: () => Promise<void>;
  stop: () => void;
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown worker error.";
};

const calculateRetryDelayMs = (attempts: number, baseDelayMs: number): number => {
  const exponent = Math.max(attempts - 1, 0);
  return baseDelayMs * 2 ** exponent;
};

export const execute = (input: ExecuteInput): WorkerAdapter => {
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseRetryDelayMs = input.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
  const sleeper =
    input.sleeper ??
    (async (durationMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
      }));

  let isRunning = true;

  const runOnce = async (): Promise<boolean> => {
    const job = await input.queue.dequeue();
    if (!job) {
      return false;
    }

    const handler = input.handlers[job.type];
    if (!handler) {
      await input.queue.markFailed({
        jobId: job.id,
        errorMessage: `No handler registered for job type "${job.type}".`,
      });
      return true;
    }

    try {
      await handler.execute(job.payload);
      await input.queue.markDone(job.id);
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      if (job.attempts < maxAttempts) {
        const delayMs = calculateRetryDelayMs(job.attempts, baseRetryDelayMs);
        const availableAt = new Date(Date.now() + delayMs);
        await input.queue.reschedule({
          jobId: job.id,
          availableAt,
          errorMessage,
        });
      } else {
        await input.queue.markFailed({
          jobId: job.id,
          errorMessage,
        });
      }
    }

    return true;
  };

  const run = async (): Promise<void> => {
    while (isRunning) {
      const processed = await runOnce();
      if (!processed) {
        await sleeper(pollIntervalMs);
      }
    }
  };

  const stop = (): void => {
    isRunning = false;
  };

  return {
    runOnce,
    run,
    stop,
  };
};
