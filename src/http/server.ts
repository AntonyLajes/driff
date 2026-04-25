import sensible from "@fastify/sensible";
import fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { handler as registerHealthRoute } from "@/http/routes/health.js";

export interface ExecuteInput {
  logger?: FastifyServerOptions["logger"];
}

export const execute = (input: ExecuteInput = {}): FastifyInstance => {
  const server = fastify({
    logger:
      input.logger ??
      (process.env.NODE_ENV === "test"
        ? false
        : { level: process.env.LOG_LEVEL ?? "info" }),
  });

  server.register(sensible);
  server.register(async (instance) => {
    await registerHealthRoute(instance);
  });

  return server;
};
