import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/ai-usage-me.js";

const JWT_SECRET = "a".repeat(32);

describe("http/routes/ai-usage-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("should return aggregate usage for the acting team", async () => {
    const usageLoader = vi.fn(async () => ({
      calls: 2,
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      projects: [
        {
          workspaceId: "w1",
          name: "App",
          slug: "app",
          repo: "acme/app",
          calls: 2,
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
        },
      ],
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: {} as never,
      jwtSecret: JWT_SECRET,
      usageLoader,
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
      url: "/api/me/ai-usage",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().usage).toMatchObject({
      calls: 2,
      totalTokens: 1500,
      projects: [{ repo: "acme/app", totalTokens: 1500 }],
    });
  });
});
