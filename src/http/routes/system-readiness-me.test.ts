import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/system-readiness-me.js";

const JWT_SECRET = "a".repeat(32);

describe("http/routes/system-readiness-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("should return aggregate readiness for the acting team", async () => {
    const readinessLoader = vi.fn(async () => ({
      projects: 2,
      searchableProjects: 1,
      searchableChanges: 4,
      connectedDestinations: 1,
      enabledDestinations: 1,
      deliveryProjects: 1,
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: {} as never,
      jwtSecret: JWT_SECRET,
      readinessLoader,
    });
    await server.ready();
    const token = signSessionJwt({
      secret: JWT_SECRET,
      userId: "00000000-0000-4000-8000-000000000099",
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const response = await server.inject({
      method: "GET",
      url: "/api/me/system-readiness",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().readiness).toMatchObject({
      searchableProjects: 1,
      searchableChanges: 4,
      enabledDestinations: 1,
    });
  });
});
