import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/product-funnel-me.js";

const JWT_SECRET = "a".repeat(32);

describe("http/routes/product-funnel-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("should return privacy-preserving funnel aggregates for the acting team", async () => {
    const funnelLoader = vi.fn(async () => ({
      connectedProjects: 2,
      historyReadyProjects: 1,
      askedProjects: 1,
      evidenceAnswerProjects: 1,
      helpfulFeedback: 3,
      unhelpfulFeedback: 1,
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: {} as never,
      jwtSecret: JWT_SECRET,
      funnelLoader,
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
      url: "/api/me/product-funnel",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().funnel).toMatchObject({
      connectedProjects: 2,
      evidenceAnswerProjects: 1,
      helpfulFeedback: 3,
    });
  });
});
