import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handler } from "@/http/routes/health.js";

describe("http/routes/health handler", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("should return ok true when /health is requested", async () => {
    const server = fastify({ logger: false });
    servers.push(server);

    await handler(server);
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("exposes queue health and returns 503 when it is degraded", async () => {
    let call = 0;
    const results = [[], [{ count: "0" }], [{ count: "2" }], [{ count: "0" }]];
    const select = vi.fn(() => {
      const result = results[call++] ?? [];
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    });
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never });
    await server.ready();

    const response = await server.inject({ method: "GET", url: "/health/queue" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "degraded" });
  });
});
