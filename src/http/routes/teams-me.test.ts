import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/teams-me.js";

describe("http/routes/teams-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  const jwtSecret = "a".repeat(32);
  const userId = "00000000-0000-4000-8000-000000000099";

  const token = () =>
    signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

  it("returns 401 when Authorization is missing", async () => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();

    const response = await server.inject({ method: "GET", url: "/api/me/teams" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "missing_or_invalid_authorization" });
  });

  it("lists teams with role and member counts, personal first", async () => {
    const personal = {
      id: userId,
      name: "antony",
      slug: "personal-abc",
      isPersonal: true,
      maxMembers: 25,
      role: "owner",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const shared = {
      id: "00000000-0000-4000-8000-0000000000ee",
      name: "Acme Mobile",
      slug: "acme-mobile",
      isPersonal: false,
      maxMembers: 25,
      role: "member",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    };

    const select = vi
      .fn()
      // memberships joined to teams
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(async () => [shared, personal]),
          })),
        })),
      }))
      // member counts grouped by team
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn(async () => [
              { teamId: shared.id, value: 4 },
              { teamId: personal.id, value: 1 },
            ]),
          })),
        })),
      }));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/teams",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.teams).toHaveLength(2);
    expect(body.teams[0]).toMatchObject({
      id: userId,
      isPersonal: true,
      role: "owner",
      memberCount: 1,
    });
    expect(body.teams[1]).toMatchObject({
      name: "Acme Mobile",
      role: "member",
      memberCount: 4,
    });
  });

  it("returns an empty list when the user has no memberships", async () => {
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({ where: vi.fn(async () => []) })),
      })),
    }));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/teams",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ teams: [] });
    expect(select).toHaveBeenCalledTimes(1);
  });
});
