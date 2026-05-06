import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/workspaces-me.js";

describe("http/routes/workspaces-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  const jwtSecret = "a".repeat(32);

  it("returns 401 when Authorization is missing", async () => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();

    const response = await server.inject({ method: "GET", url: "/api/me/workspaces" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "missing_or_invalid_authorization" });
  });

  it("returns 401 when the session JWT is invalid", async () => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces",
      headers: { authorization: "Bearer not-a-jwt" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "invalid_session" });
  });

  it("returns workspaces from the database for a valid session", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const orderBy = vi.fn(async () => []);
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ workspaces: [] });
    expect(select).toHaveBeenCalledOnce();
  });

  it("returns 201 after inserting a workspace", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const updatedAt = new Date("2026-01-01T00:00:00.000Z");
    const createdRow = {
      id: "00000000-0000-4000-8000-0000000000aa",
      name: "Acme",
      slug: "acme",
      workspaceKind: "ios_plist" as string | null,
      createdAt,
      updatedAt,
    };

    const returning = vi.fn(async () => [createdRow]);
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Acme", workspaceKind: "ios_plist" },
    });

    expect(response.statusCode).toBe(201);
    const json = response.json() as { workspace: typeof createdRow };
    expect(json.workspace.id).toBe(createdRow.id);
    expect(json.workspace.slug).toBe("acme");
    expect(json.workspace.workspaceKind).toBe("ios_plist");
    expect(insert).toHaveBeenCalledOnce();
  });

  it("returns 409 when the slug is already taken", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const returning = vi.fn(() =>
      Promise.reject(Object.assign(new Error("duplicate"), { code: "23505" })),
    );
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Dup", slug: "dup" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "workspace_slug_taken" });
  });
});
