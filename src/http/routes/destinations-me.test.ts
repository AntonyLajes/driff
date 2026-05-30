import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler, type DestinationsMeRegistrationInput } from "@/http/routes/destinations-me.js";

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
});
