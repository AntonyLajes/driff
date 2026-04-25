import type { FastifyInstance } from "fastify";

export const handler = async (server: FastifyInstance): Promise<void> => {
  server.get("/health", async () => {
    return { ok: true };
  });
};
