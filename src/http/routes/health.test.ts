import fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

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
});
