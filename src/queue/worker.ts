import type { QueueAdapter } from "@/queue/queue.js";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_RETRY_DELAY_MS = 60_000;

export interface JobHandler {
  execute: (payload: Record<string, unknown>) => Promise<void>;
}

export interface WorkerLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

const defaultLogger: WorkerLogger = {
  info: (message, meta) => console.log(`[worker] ${message}`, meta ?? ""),
  error: (message, meta) => console.error(`[worker] ${message}`, meta ?? ""),
};

export interface ExecuteInput {
  queue: QueueAdapter;
  handlers: Record<string, JobHandler>;
  pollIntervalMs?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  sleeper?: (durationMs: number) => Promise<void>;
  logger?: WorkerLogger;
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
  const logger = input.logger ?? defaultLogger;

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
      logger.info("job done", { jobId: job.id, type: job.type });
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
        logger.error("job failed; rescheduled", {
          jobId: job.id,
          type: job.type,
          attempts: job.attempts,
          errorMessage,
        });
      } else {
        await input.queue.markFailed({
          jobId: job.id,
          errorMessage,
        });
        logger.error("job failed; giving up", {
          jobId: job.id,
          type: job.type,
          attempts: job.attempts,
          errorMessage,
        });
      }
    }

    return true;
  };

  const run = async (): Promise<void> => {
    logger.info("worker started", { pollIntervalMs });
    while (isRunning) {
      let processed = false;
      try {
        processed = await runOnce();
      } catch (error) {
        // A transient failure (e.g. a dropped DB connection during an idle
        // dequeue) must NOT kill the poll loop. Previously an error here escaped
        // run() and the loop terminated silently, leaving jobs stuck forever.
        // Log it and keep polling after a backoff.
        logger.error("poll iteration failed; continuing", {
          errorMessage: getErrorMessage(error),
        });
        await sleeper(pollIntervalMs);
        continue;
      }
      if (!processed) {
        await sleeper(pollIntervalMs);
      }
    }
    logger.info("worker stopped");
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
