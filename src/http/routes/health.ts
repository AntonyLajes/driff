import type { FastifyInstance } from "fastify";

import type { Database } from "@/db/client.js";
import {
  computeQueueHealth,
  type QueueHealthThresholds,
} from "@/queue/queue-health.js";

export interface HealthRouteInput {
  /** When set, registers `GET /health/queue` (job-queue liveness for monitors). */
  db?: Database;
  queueThresholds?: Partial<QueueHealthThresholds>;
}

export const handler = async (
  server: FastifyInstance,
  input: HealthRouteInput = {},
): Promise<void> => {
  server.get("/health", async () => {
    return { ok: true };
  });

  const db = input.db;
  if (db !== undefined) {
    server.get("/health/queue", async (_request, reply) => {
      const health = await computeQueueHealth({ db, thresholds: input.queueThresholds });
      // 503 on degraded so an external uptime monitor flags it without parsing the body.
      reply.status(health.status === "ok" ? 200 : 503);
      return health;
    });
  }
};
