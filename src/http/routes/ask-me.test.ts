import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/ask-me.js";

const JWT_SECRET = "a".repeat(32);
const USER_ID = "00000000-0000-4000-8000-000000000099";
const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000aa";

const token = () =>
  signSessionJwt({
    secret: JWT_SECRET,
    userId: USER_ID,
    email: "user@example.com",
    expiresInSeconds: 3600,
  });

const buildWorkspaceDb = (rows: unknown[]) => {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as never, select };
};

describe("http/routes/ask-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("should reject questions without a bearer session", async () => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret: JWT_SECRET });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/ask",
      payload: { question: "What changed?" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should scope a valid question to the workspace and acting team", async () => {
    const workspaceDb = buildWorkspaceDb([
      { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
    ]);
    const historySearcher = vi.fn(async () => ({
      status: "no_evidence" as const,
      mode: "change" as const,
      confidence: "none" as const,
      queryTerms: ["checkout"],
      version: null,
      matches: [],
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      historySearcher,
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/ask",
      headers: { authorization: `Bearer ${token()}` },
      payload: { question: "  checkout button  " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        workspace: { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
        question: "checkout button",
        status: "no_evidence",
      }),
    );
    expect(historySearcher).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        question: "checkout button",
      }),
    );
  });

  it("should reject questions outside the accepted contract", async () => {
    const workspaceDb = buildWorkspaceDb([]);
    const historySearcher = vi.fn();
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      historySearcher,
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/ask",
      headers: { authorization: `Bearer ${token()}` },
      payload: { question: "?" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_ask_question" });
    expect(workspaceDb.select).not.toHaveBeenCalled();
    expect(historySearcher).not.toHaveBeenCalled();
  });
});
