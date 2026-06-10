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

  const TEAM_ID = "00000000-0000-4000-8000-0000000000ee";
  const membershipSelect = (role: string) => () => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [{ role, isPersonal: false }]) })),
      })),
    })),
  });

  it("lists team members ordered by role with your-flag", async () => {
    const memberRows = [
      {
        userId,
        role: "owner",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        name: "Antony Lajes",
        email: "antony@superhealth.xyz",
        picture: null,
      },
      {
        userId: "00000000-0000-4000-8000-0000000000b2",
        role: "member",
        createdAt: new Date("2026-06-02T00:00:00.000Z"),
        name: "Diego Alves",
        email: "diego@acme.io",
        picture: null,
      },
    ];
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ orderBy: vi.fn(async () => memberRows) })),
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
      url: `/api/me/teams/${TEAM_ID}/members`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.yourRole).toBe("owner");
    expect(body.members[0]).toMatchObject({ role: "owner", isYou: true, name: "Antony Lajes" });
    expect(body.members[1]).toMatchObject({ role: "member", isYou: false });
  });

  it("403s listing members of a team you don't belong to", async () => {
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
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
      url: `/api/me/teams/${TEAM_ID}/members`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "not_a_team_member" });
  });

  it("lists pending invites for a team", async () => {
    const inviteRows = [
      {
        id: "00000000-0000-4000-8000-0000000000c1",
        email: "lucas@acme.io",
        role: "member",
        expiresAt: new Date("2026-06-17T00:00:00.000Z"),
        createdAt: new Date("2026-06-10T00:00:00.000Z"),
      },
    ];
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("admin"))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn(async () => inviteRows) })),
        })),
      }));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: `/api/me/teams/${TEAM_ID}/invites`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().invites[0]).toMatchObject({
      email: "lucas@acme.io",
      role: "member",
    });
  });

  it("creates a team and adds the creator as owner", async () => {
    const createdTeam = {
      id: "00000000-0000-4000-8000-0000000000ee",
      name: "Acme Mobile",
      slug: "acme-mobile",
      isPersonal: false,
      maxMembers: 25,
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
    };
    const teamReturning = vi.fn(async () => [createdTeam]);
    const teamValues = vi.fn(() => ({ returning: teamReturning }));
    const memberValues = vi.fn(async () => undefined);
    const insert = vi
      .fn()
      .mockImplementationOnce(() => ({ values: teamValues }))
      .mockImplementationOnce(() => ({ values: memberValues }));
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/teams",
      headers: { authorization: `Bearer ${token()}` },
      payload: { name: "Acme Mobile" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().team).toMatchObject({
      id: createdTeam.id,
      name: "Acme Mobile",
      slug: "acme-mobile",
      isPersonal: false,
      role: "owner",
      memberCount: 1,
    });
    expect(teamValues).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme Mobile", isPersonal: false }),
    );
    expect(memberValues).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: createdTeam.id, userId, role: "owner" }),
    );
  });

  it("rejects creating a team with a blank name", async () => {
    const insert = vi.fn();
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/teams",
      headers: { authorization: `Bearer ${token()}` },
      payload: { name: "   " },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_body" });
    expect(insert).not.toHaveBeenCalled();
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
