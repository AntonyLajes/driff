import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { sealSecret } from "@/auth/token-aes.js";
import {
  buildDestinationsMeRegistrationInput,
  handler,
  type DestinationsMeRegistrationInput,
} from "@/http/routes/destinations-me.js";
import { listNotionDatabases, suggestNotionDatabaseRoles } from "@/notion/list-databases.js";

vi.mock("@/notion/list-databases.js", () => ({
  listNotionDatabases: vi.fn(),
  suggestNotionDatabaseRoles: vi.fn(),
}));

const jwtSecret = "a".repeat(32);
const userId = "00000000-0000-4000-8000-000000000099";

const baseInput = (db: unknown): DestinationsMeRegistrationInput => ({
  db: db as never,
  jwtSecret,
  notionClientId: "notion-client",
  notionClientSecret: "notion-secret",
  publicApiUrl: "https://api.example.com",
  frontendUrl: "https://app.example.com",
});

const token = () =>
  signSessionJwt({ secret: jwtSecret, userId, email: "u@example.com", expiresInSeconds: 3600 });

// Resolves the workspace-by-slug lookup used by every endpoint.
const workspaceLookupSelect = () => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: "ws-1", slug: "ride-pack" }]) })),
  })),
});

describe("http/routes/destinations-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers.length = 0;
    vi.restoreAllMocks();
  });

  const start = async (db: unknown) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, baseInput(db));
    await server.ready();
    return server;
  };

  it("returns a Notion authorize URL from oauth/start", async () => {
    const select = vi.fn().mockImplementationOnce(workspaceLookupSelect);
    const server = await start({ select });

    const res = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion/oauth/start",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { authorizeUrl: string };
    expect(body.authorizeUrl).toContain("https://api.notion.com/v1/oauth/authorize");
    expect(body.authorizeUrl).toContain("client_id=notion-client");
    expect(body.authorizeUrl).toContain("state=");
  });

  it("lists destinations with a connected flag", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(workspaceLookupSelect)
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            {
              type: "notion",
              enabled: true,
              config: { prDatabaseId: "db-1", workspaceName: "My WS" },
              secretCiphertext: "sealed",
              externalAccountId: "notion-ws",
            },
          ]),
        })),
      }));
    const server = await start({ select });

    const res = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      destinations: [{ type: "notion", enabled: true, connected: true }],
    });
    // secret is never returned
    expect(JSON.stringify(res.json())).not.toContain("sealed");
  });

  it("patches the notion destination config", async () => {
    const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) }));
    const select = vi
      .fn()
      .mockImplementationOnce(workspaceLookupSelect)
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: "d-1", config: {} }]) })),
        })),
      }));
    const server = await start({ select, update });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion",
      headers: { authorization: `Bearer ${token()}` },
      payload: { config: { prDatabaseId: "pr-db" } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ destination: { config: { prDatabaseId: "pr-db" } } });
    expect(update).toHaveBeenCalledOnce();
  });

  it("blocks a member from patching a destination in a shared team", async () => {
    const membershipSelect = () => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ role: "member", isPersonal: false }]),
          })),
        })),
      })),
    });
    const update = vi.fn();
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect)
      .mockImplementationOnce(workspaceLookupSelect);
    const server = await start({ select, update });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion",
      headers: {
        authorization: `Bearer ${token()}`,
        "x-team-id": "00000000-0000-4000-8000-0000000000ee",
      },
      payload: { config: { prDatabaseId: "pr-db" } },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "insufficient_role" });
    expect(update).not.toHaveBeenCalled();
  });

  it("404s when patching a destination that is not connected", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(workspaceLookupSelect)
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
      }));
    const server = await start({ select, update: vi.fn() });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion",
      headers: { authorization: `Bearer ${token()}` },
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "destination_not_connected" });
  });

  it("deletes a destination", async () => {
    const del = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
    const select = vi.fn().mockImplementationOnce(workspaceLookupSelect);
    const server = await start({ select, delete: del });

    const res = await server.inject({
      method: "DELETE",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(res.statusCode).toBe(204);
    expect(del).toHaveBeenCalledOnce();
  });

  it("400s listing databases when notion is not connected", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(workspaceLookupSelect)
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [{ secretCiphertext: null }]) })),
        })),
      }));
    const server = await start({ select });

    const res = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion/databases",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "notion_not_connected" });
  });

  it("rejects an unknown destination type", async () => {
    const select = vi.fn().mockImplementationOnce(workspaceLookupSelect);
    const server = await start({ select, update: vi.fn() });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations/telegram",
      headers: { authorization: `Bearer ${token()}` },
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_destination_type" });
  });

  it("only builds registration input when every integration setting exists", () => {
    const configured = buildDestinationsMeRegistrationInput({
      NOTION_OAUTH_CLIENT_ID: " client ",
      NOTION_OAUTH_CLIENT_SECRET: "secret",
      AUTH_JWT_SECRET: jwtSecret,
      AUTH_PUBLIC_URL: "https://api.example.com///",
      FRONTEND_URL: "https://app.example.com/",
    } as never);

    expect(configured).toMatchObject({
      notionClientId: " client ",
      publicApiUrl: "https://api.example.com",
      frontendUrl: "https://app.example.com",
    });
    for (const missing of [
      "NOTION_OAUTH_CLIENT_ID",
      "NOTION_OAUTH_CLIENT_SECRET",
      "AUTH_JWT_SECRET",
      "AUTH_PUBLIC_URL",
      "FRONTEND_URL",
    ] as const) {
      const env = {
        NOTION_OAUTH_CLIENT_ID: "client",
        NOTION_OAUTH_CLIENT_SECRET: "secret",
        AUTH_JWT_SECRET: jwtSecret,
        AUTH_PUBLIC_URL: "https://api.example.com",
        FRONTEND_URL: "https://app.example.com",
      };
      delete env[missing];
      expect(buildDestinationsMeRegistrationInput(env as never)).toBeUndefined();
    }
  });

  it.each([
    ["POST", "/api/me/workspaces/by-slug/ride-pack/destinations/notion/oauth/start"],
    ["GET", "/api/me/workspaces/by-slug/ride-pack/destinations"],
    ["PATCH", "/api/me/workspaces/by-slug/ride-pack/destinations/notion"],
    ["DELETE", "/api/me/workspaces/by-slug/ride-pack/destinations/notion"],
    ["GET", "/api/me/workspaces/by-slug/ride-pack/destinations/notion/databases"],
  ] as const)("rejects an invalid session for %s %s", async (method, url) => {
    const server = await start({ select: vi.fn() });
    const res = await server.inject({ method, url, payload: method === "PATCH" ? {} : undefined });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "invalid_session" });
  });

  it.each([
    ["oauth start", "POST", "/api/me/workspaces/by-slug/---/destinations/notion/oauth/start"],
    ["list", "GET", "/api/me/workspaces/by-slug/---/destinations"],
    ["patch", "PATCH", "/api/me/workspaces/by-slug/---/destinations/notion"],
    ["delete", "DELETE", "/api/me/workspaces/by-slug/---/destinations/notion"],
    ["databases", "GET", "/api/me/workspaces/by-slug/---/destinations/notion/databases"],
  ] as const)("rejects an invalid workspace slug from %s", async (_name, method, url) => {
    const server = await start({ select: vi.fn(), update: vi.fn(), delete: vi.fn() });
    const res = await server.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token()}` },
      payload: method === "PATCH" ? { enabled: true } : undefined,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_slug" });
  });

  it.each([
    ["oauth start", "POST", "/api/me/workspaces/by-slug/missing/destinations/notion/oauth/start"],
    ["list", "GET", "/api/me/workspaces/by-slug/missing/destinations"],
    ["patch", "PATCH", "/api/me/workspaces/by-slug/missing/destinations/notion"],
    ["delete", "DELETE", "/api/me/workspaces/by-slug/missing/destinations/notion"],
    ["databases", "GET", "/api/me/workspaces/by-slug/missing/destinations/notion/databases"],
  ] as const)("returns not found from %s", async (_name, method, url) => {
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
    }));
    const server = await start({ select, update: vi.fn(), delete: vi.fn() });
    const res = await server.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token()}` },
      payload: method === "PATCH" ? { enabled: true } : undefined,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "workspace_not_found" });
  });

  it("redirects malformed Notion callbacks without touching the database", async () => {
    const select = vi.fn();
    const server = await start({ select });
    const res = await server.inject({
      method: "GET",
      url: "/api/me/destinations/notion/oauth/callback?state=invalid",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://app.example.com/workspaces?notion_oauth=error");
    expect(select).not.toHaveBeenCalled();
  });

  it("exchanges a Notion code and stores its encrypted credentials", async () => {
    const oauthStartSelect = vi.fn().mockImplementationOnce(workspaceLookupSelect);
    const startServer = await start({ select: oauthStartSelect });
    const startRes = await startServer.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion/oauth/start",
      headers: { authorization: `Bearer ${token()}` },
    });
    const state = new URL((startRes.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get("state");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "notion-token", workspace_id: "notion-1", workspace_name: "Driff" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const onConflictDoUpdate = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [{ slug: "ride-pack" }]) })),
      })),
    }));
    const callbackServer = await start({ select, insert });
    const res = await callbackServer.inject({
      method: "GET",
      url: `/api/me/destinations/notion/oauth/callback?code=good&state=${encodeURIComponent(state ?? "")}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      "https://app.example.com/workspaces/ride-pack/integrations?notion_oauth=success",
    );
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ externalAccountId: "notion-1" }));
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it.each([
    [new Response("denied", { status: 401 }), "notion_token_http_401"],
    [new Response(JSON.stringify({ workspace_id: "notion-1" }), { status: 200 }), "missing_access_token"],
  ])("redirects failed Notion exchanges (%s)", async (response, _case) => {
    const oauthStartSelect = vi.fn().mockImplementationOnce(workspaceLookupSelect);
    const startServer = await start({ select: oauthStartSelect });
    const startRes = await startServer.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion/oauth/start",
      headers: { authorization: `Bearer ${token()}` },
    });
    const state = new URL((startRes.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get("state");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
    const select = vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
    }));
    const callbackServer = await start({ select, insert: vi.fn() });
    const res = await callbackServer.inject({
      method: "GET",
      url: `/api/me/destinations/notion/oauth/callback?code=bad&state=${encodeURIComponent(state ?? "")}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://app.example.com/workspaces?notion_oauth=exchange_failed");
  });

  it("normalizes all destination ids while patching", async () => {
    const set = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
    const update = vi.fn(() => ({ set }));
    const select = vi
      .fn()
      .mockImplementationOnce(workspaceLookupSelect)
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ id: "d-1", config: { prDatabaseId: "old", keep: true } }]),
          })),
        })),
      }));
    const server = await start({ select, update });
    const res = await server.inject({
      method: "PATCH",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion",
      headers: { authorization: `Bearer ${token()}` },
      payload: {
        enabled: false,
        config: { prDatabaseId: " ", releasesDatabaseId: null, pushesDatabaseId: " push-db " },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ destination: { config: { keep: true, pushesDatabaseId: "push-db" } } });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it.each([{}, { unexpected: true }, { config: { prDatabaseId: 42 } }])(
    "rejects an invalid destination patch: %j",
    async (payload) => {
      const server = await start({ select: vi.fn().mockImplementationOnce(workspaceLookupSelect) });
      const res = await server.inject({
        method: "PATCH",
        url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion",
        headers: { authorization: `Bearer ${token()}` },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid_body" });
    },
  );

  it("lists connected Notion databases and role suggestions", async () => {
    vi.mocked(listNotionDatabases).mockResolvedValueOnce([{ id: "db-1", title: "PRs" }] as never);
    vi.mocked(suggestNotionDatabaseRoles).mockReturnValueOnce({ prDatabaseId: "db-1" } as never);
    const select = vi
      .fn()
      .mockImplementationOnce(workspaceLookupSelect)
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ secretCiphertext: sealSecret("notion-token", jwtSecret) }]),
          })),
        })),
      }));
    const server = await start({ select });
    const res = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion/databases",
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ databases: [{ id: "db-1" }], suggestions: { prDatabaseId: "db-1" } });
    expect(listNotionDatabases).toHaveBeenCalledWith("notion-token");
  });

  it.each(["broken-cipher", sealSecret("notion-token", jwtSecret)])(
    "handles unusable Notion database credentials",
    async (secretCiphertext) => {
      if (secretCiphertext !== "broken-cipher") {
        vi.mocked(listNotionDatabases).mockRejectedValueOnce(new Error("notion unavailable"));
      }
      const select = vi
        .fn()
        .mockImplementationOnce(workspaceLookupSelect)
        .mockImplementationOnce(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn(async () => [{ secretCiphertext }]) })),
          })),
        }));
      const server = await start({ select });
      const res = await server.inject({
        method: "GET",
        url: "/api/me/workspaces/by-slug/ride-pack/destinations/notion/databases",
        headers: { authorization: `Bearer ${token()}` },
      });
      expect(res.statusCode).toBe(secretCiphertext === "broken-cipher" ? 400 : 502);
    },
  );
});
