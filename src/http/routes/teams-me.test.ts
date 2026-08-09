import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const { sendInviteEmailMock } = vi.hoisted(() => ({
  sendInviteEmailMock: vi.fn(async () => ({ sent: true })),
}));
vi.mock("@/email/send-invite-email.js", () => ({
  sendInviteEmail: sendInviteEmailMock,
}));

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/teams-me.js";

describe("http/routes/teams-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
    sendInviteEmailMock.mockClear();
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

  const protectedTeamRoutes = [
    ["GET", "/api/me/teams"],
    ["GET", "/api/me/teams/00000000-0000-4000-8000-0000000000ee/members"],
    ["GET", "/api/me/teams/00000000-0000-4000-8000-0000000000ee/invites"],
    ["POST", "/api/me/teams/00000000-0000-4000-8000-0000000000ee/invites"],
    [
      "DELETE",
      "/api/me/teams/00000000-0000-4000-8000-0000000000ee/invites/00000000-0000-4000-8000-0000000000cc",
    ],
    [
      "POST",
      "/api/me/teams/00000000-0000-4000-8000-0000000000ee/invites/00000000-0000-4000-8000-0000000000cc/resend",
    ],
    ["POST", "/api/invites/invite-token/accept"],
    [
      "PATCH",
      "/api/me/teams/00000000-0000-4000-8000-0000000000ee/members/00000000-0000-4000-8000-0000000000bb",
    ],
    [
      "DELETE",
      "/api/me/teams/00000000-0000-4000-8000-0000000000ee/members/00000000-0000-4000-8000-0000000000bb",
    ],
    ["POST", "/api/me/teams/00000000-0000-4000-8000-0000000000ee/leave"],
    ["PATCH", "/api/me/teams/00000000-0000-4000-8000-0000000000ee"],
    ["DELETE", "/api/me/teams/00000000-0000-4000-8000-0000000000ee"],
    ["POST", "/api/me/teams"],
  ] as const;

  it.each(protectedTeamRoutes)("protects %s %s without authorization", async (method, url) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method,
      url,
      payload: method === "POST" || method === "PATCH" ? {} : undefined,
    });
    expect(response.statusCode).toBe(401);
  });

  it.each(protectedTeamRoutes)("rejects an invalid JWT for %s %s", async (method, url) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method,
      url,
      headers: { authorization: "Bearer invalid" },
      payload: method === "POST" || method === "PATCH" ? {} : undefined,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "invalid_session" });
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

  const teamLimitSelect = (name: string, maxMembers: number) => () => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => [{ name, maxMembers }]) })),
    })),
  });
  const memberEmailsSelect = (emails: string[]) => () => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(async () => emails.map((email) => ({ email }))),
      })),
    })),
  });
  const pendingEmailsSelect = (emails: string[]) => () => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => emails.map((email) => ({ email }))),
    })),
  });

  it("creates an invite, sends the email and returns an accept link", async () => {
    const inviteRow = {
      id: "00000000-0000-4000-8000-0000000000c9",
      email: "new@acme.io",
      role: "member",
      expiresAt: new Date("2026-06-17T00:00:00.000Z"),
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
    };
    const returning = vi.fn(async () => [inviteRow]);
    const insert = vi.fn(() => ({ values: vi.fn(() => ({ returning })) }));
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(teamLimitSelect("Acme Mobile", 25))
      .mockImplementationOnce(memberEmailsSelect(["antony@superhealth.xyz"]))
      .mockImplementationOnce(pendingEmailsSelect([]));
    const db = { select, insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db,
      jwtSecret,
      resendApiKey: "re_x",
      resendFrom: "Driff <invites@driff.dev>",
      frontendUrl: "https://app.driff.dev",
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/invites`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { email: "New@Acme.io", role: "member" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.invite).toMatchObject({ email: "new@acme.io", role: "member" });
    expect(body.acceptUrl).toMatch(/^https:\/\/app\.driff\.dev\/invite\/.+/);
    expect(body.emailSent).toBe(true);
    expect(sendInviteEmailMock).toHaveBeenCalledOnce();
  });

  it("rejects an invite when the seat limit is reached", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("admin"))
      .mockImplementationOnce(teamLimitSelect("Acme Mobile", 1))
      .mockImplementationOnce(memberEmailsSelect(["a@acme.io"]))
      .mockImplementationOnce(pendingEmailsSelect([]));
    const insert = vi.fn();
    const db = { select, insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/invites`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { email: "new@acme.io", role: "member" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "seat_limit_reached" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("blocks a member from creating an invite", async () => {
    const select = vi.fn().mockImplementationOnce(membershipSelect("member"));
    const insert = vi.fn();
    const db = { select, insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/invites`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { email: "new@acme.io", role: "member" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "insufficient_role" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("409s inviting an email that is already a member", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(teamLimitSelect("Acme Mobile", 25))
      .mockImplementationOnce(memberEmailsSelect(["dup@acme.io"]))
      .mockImplementationOnce(pendingEmailsSelect([]));
    const db = { select, insert: vi.fn() } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/invites`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { email: "dup@acme.io", role: "member" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "already_member" });
  });

  it("accepts an invite when the signed-in email matches", async () => {
    const inviteRow = {
      id: "00000000-0000-4000-8000-0000000000c9",
      teamId: TEAM_ID,
      email: "user@example.com",
      role: "member",
      expiresAt: new Date(Date.now() + 86_400_000),
      acceptedAt: null,
    };
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [inviteRow]) })),
      })),
    }));
    const onConflictDoNothing = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoNothing })) }));
    const updateWhere = vi.fn(async () => undefined);
    const update = vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) }));
    const db = { select, insert, update } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/invites/tok_abc/accept",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ teamId: TEAM_ID });
    expect(insert).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });

  it("rejects accepting an invite addressed to a different email", async () => {
    const inviteRow = {
      id: "00000000-0000-4000-8000-0000000000c9",
      teamId: TEAM_ID,
      email: "someone-else@acme.io",
      role: "member",
      expiresAt: new Date(Date.now() + 86_400_000),
      acceptedAt: null,
    };
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [inviteRow]) })),
      })),
    }));
    const insert = vi.fn();
    const db = { select, insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/invites/tok_abc/accept",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "invite_email_mismatch" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns 410 accepting an expired invite", async () => {
    const inviteRow = {
      id: "00000000-0000-4000-8000-0000000000c9",
      teamId: TEAM_ID,
      email: "user@example.com",
      role: "member",
      expiresAt: new Date(Date.now() - 1000),
      acceptedAt: null,
    };
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [inviteRow]) })),
      })),
    }));
    const db = { select, insert: vi.fn() } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/invites/tok_abc/accept",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: "invite_expired" });
  });

  it("previews an invite by token without auth", async () => {
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [
              {
                email: "new@acme.io",
                role: "member",
                expiresAt: new Date(Date.now() + 86_400_000),
                acceptedAt: null,
                teamName: "Acme Mobile",
              },
            ]),
          })),
        })),
      })),
    }));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({ method: "GET", url: "/api/invites/tok_abc" });

    expect(response.statusCode).toBe(200);
    expect(response.json().invite).toMatchObject({
      teamName: "Acme Mobile",
      role: "member",
      expired: false,
      accepted: false,
    });
  });

  const targetMemberSelect = (role: string) => () => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => [{ role }]) })),
    })),
  });

  it("lets an owner change a member's role", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(targetMemberSelect("member"));
    const updateWhere = vi.fn(async () => undefined);
    const update = vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) }));
    const db = { select, update } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: `/api/me/teams/${TEAM_ID}/members/00000000-0000-4000-8000-0000000000b2`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { role: "admin" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ role: "admin" });
    expect(update).toHaveBeenCalledOnce();
  });

  it("blocks an admin from changing roles", async () => {
    const select = vi.fn().mockImplementationOnce(membershipSelect("admin"));
    const db = { select, update: vi.fn() } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: `/api/me/teams/${TEAM_ID}/members/00000000-0000-4000-8000-0000000000b2`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { role: "admin" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "insufficient_role" });
  });

  it("lets an admin remove a member but not another admin", async () => {
    const memberSelect = vi
      .fn()
      .mockImplementationOnce(membershipSelect("admin"))
      .mockImplementationOnce(targetMemberSelect("member"));
    const deleteWhere = vi.fn(async () => undefined);
    const deleteFn = vi.fn(() => ({ where: deleteWhere }));

    const server1 = fastify({ logger: false });
    servers.push(server1);
    await handler(server1, { db: { select: memberSelect, delete: deleteFn } as never, jwtSecret });
    await server1.ready();
    const ok = await server1.inject({
      method: "DELETE",
      url: `/api/me/teams/${TEAM_ID}/members/00000000-0000-4000-8000-0000000000b2`,
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(ok.statusCode).toBe(204);

    const adminSelect = vi
      .fn()
      .mockImplementationOnce(membershipSelect("admin"))
      .mockImplementationOnce(targetMemberSelect("admin"));
    const server2 = fastify({ logger: false });
    servers.push(server2);
    await handler(server2, { db: { select: adminSelect, delete: vi.fn() } as never, jwtSecret });
    await server2.ready();
    const blocked = await server2.inject({
      method: "DELETE",
      url: `/api/me/teams/${TEAM_ID}/members/00000000-0000-4000-8000-0000000000b3`,
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(blocked.statusCode).toBe(403);
  });

  it("blocks the last owner from leaving", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({ where: vi.fn(async () => [{ value: 1 }]) })),
      }));
    const db = { select, delete: vi.fn() } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/leave`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "last_owner" });
  });

  it("lets a member leave a team", async () => {
    const select = vi.fn().mockImplementationOnce(membershipSelect("member"));
    const deleteWhere = vi.fn(async () => undefined);
    const deleteFn = vi.fn(() => ({ where: deleteWhere }));
    const db = { select, delete: deleteFn } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/leave`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(204);
    expect(deleteFn).toHaveBeenCalledOnce();
  });

  it("lets an owner rename a team and blocks renaming the personal team", async () => {
    const renameReturning = vi.fn(async () => [
      { id: TEAM_ID, name: "Renamed", slug: "acme-mobile" },
    ]);
    const renameSelect = vi.fn().mockImplementationOnce(membershipSelect("owner"));
    const update = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: renameReturning })) })),
    }));
    const server1 = fastify({ logger: false });
    servers.push(server1);
    await handler(server1, { db: { select: renameSelect, update } as never, jwtSecret });
    await server1.ready();
    const ok = await server1.inject({
      method: "PATCH",
      url: `/api/me/teams/${TEAM_ID}`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { name: "Renamed" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().team).toMatchObject({ name: "Renamed" });

    // Personal team (id === userId) short-circuits to personal context.
    const server2 = fastify({ logger: false });
    servers.push(server2);
    await handler(server2, { db: { select: vi.fn(), update: vi.fn() } as never, jwtSecret });
    await server2.ready();
    const blocked = await server2.inject({
      method: "PATCH",
      url: `/api/me/teams/${userId}`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { name: "Nope" },
    });
    expect(blocked.statusCode).toBe(403);
  });

  it("lets an owner delete a team", async () => {
    const select = vi.fn().mockImplementationOnce(membershipSelect("owner"));
    const deleteWhere = vi.fn(async () => undefined);
    const deleteFn = vi.fn(() => ({ where: deleteWhere }));
    const db = { select, delete: deleteFn } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "DELETE",
      url: `/api/me/teams/${TEAM_ID}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(204);
    expect(deleteFn).toHaveBeenCalledOnce();
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

  it("retries with a suffixed slug when the base slug collides", async () => {
    const createdRow = {
      id: "00000000-0000-4000-8000-0000000000ef",
      name: "Acme",
      slug: "acme-a1b2c3",
      isPersonal: false,
      maxMembers: 25,
      createdAt: new Date("2026-06-12T00:00:00.000Z"),
    };
    // How drizzle surfaces a postgres unique violation (code in the cause).
    const wrapped = {
      name: "DrizzleQueryError",
      cause: { code: "23505", constraint_name: "teams_slug_unique" },
    };
    const slugs: string[] = [];
    const teamInsert = (behavior: () => Promise<unknown>) => () => ({
      values: vi.fn((row: { slug: string }) => {
        slugs.push(row.slug);
        return { returning: behavior };
      }),
    });
    const insert = vi
      .fn()
      // attempt 1: base slug "acme" collides
      .mockImplementationOnce(
        teamInsert(async () => {
          throw wrapped;
        }),
      )
      // attempt 2: suffixed slug succeeds
      .mockImplementationOnce(teamInsert(async () => [createdRow]))
      // owner membership insert
      .mockImplementationOnce(() => ({ values: vi.fn(async () => undefined) }));
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/teams",
      headers: { authorization: `Bearer ${token()}` },
      payload: { name: "Acme" },
    });

    expect(response.statusCode).toBe(201);
    expect(slugs[0]).toBe("acme");
    expect(slugs[1]).toMatch(/^acme-.+/);
    expect(slugs[1]).not.toBe("acme");
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

  it("returns not found when inviting into a missing team", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
      }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/invites`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { email: "new@example.com", role: "member" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "team_not_found" });
  });

  it.each([
    ["DELETE", `/api/me/teams/${TEAM_ID}/invites/not-a-uuid`],
    ["POST", `/api/me/teams/${TEAM_ID}/invites/not-a-uuid/resend`],
  ] as const)("rejects malformed invite identifiers for %s", async (method, url) => {
    const select = vi.fn().mockImplementationOnce(membershipSelect("owner"));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_invite" });
  });

  it("returns not found when previewing or accepting a missing invite", async () => {
    const emptySelect = () => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
        where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
      })),
    });
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select: vi.fn(emptySelect) } as never, jwtSecret });
    await server.ready();
    const preview = await server.inject({ method: "GET", url: "/api/invites/missing" });
    const accept = await server.inject({
      method: "POST",
      url: "/api/invites/missing/accept",
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(preview.statusCode).toBe(404);
    expect(accept.statusCode).toBe(404);
  });

  it("validates role changes before loading the target member", async () => {
    const select = vi.fn().mockImplementationOnce(membershipSelect("owner"));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "PATCH",
      url: `/api/me/teams/${TEAM_ID}/members/00000000-0000-4000-8000-0000000000bb`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { role: "owner" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_body" });
  });

  it("returns not found when removing an unknown member", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
      }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "DELETE",
      url: `/api/me/teams/${TEAM_ID}/members/00000000-0000-4000-8000-0000000000bb`,
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "member_not_found" });
  });

  it("lets an owner leave when another owner remains", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({ where: vi.fn(async () => [{ value: 2 }]) })),
      }));
    const del = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select, delete: del } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/leave`,
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(response.statusCode).toBe(204);
    expect(del).toHaveBeenCalledOnce();
  });

  it("validates team renames and handles a disappeared team", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(membershipSelect("owner"));
    const returning = vi.fn(async () => []);
    const update = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select, update } as never, jwtSecret });
    await server.ready();
    const invalid = await server.inject({
      method: "PATCH",
      url: `/api/me/teams/${TEAM_ID}`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { name: " " },
    });
    const missing = await server.inject({
      method: "PATCH",
      url: `/api/me/teams/${TEAM_ID}`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { name: "Renamed" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
  });

  it.each([
    [[], 500, "insert_failed"],
    [new Error("database down"), 500, "internal_error"],
  ] as const)("handles team creation failures", async (result, status, error) => {
    const returning = vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const insert = vi.fn(() => ({ values: vi.fn(() => ({ returning })) }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { insert } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/api/me/teams",
      headers: { authorization: `Bearer ${token()}` },
      payload: { name: "Acme" },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error });
  });

  /* ---- Edge cases filling the permission/lifecycle matrix ---- */

  const startTeams = async (db: unknown) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: db as never, jwtSecret });
    await server.ready();
    return server;
  };
  const authed = { authorization: `Bearer ${token()}` };

  it("409s inviting an email that already has a pending invite", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(teamLimitSelect("Acme Mobile", 25))
      .mockImplementationOnce(memberEmailsSelect(["someone@acme.io"]))
      .mockImplementationOnce(pendingEmailsSelect(["dup@acme.io"]));
    const server = await startTeams({ select, insert: vi.fn() });
    const res = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/invites`,
      headers: authed,
      payload: { email: "dup@acme.io", role: "member" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "invite_exists" });
  });

  it("400s inviting someone as owner", async () => {
    const select = vi.fn().mockImplementationOnce(membershipSelect("owner"));
    const server = await startTeams({ select, insert: vi.fn() });
    const res = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/invites`,
      headers: authed,
      payload: { email: "new@acme.io", role: "owner" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_body" });
  });

  it("revokes an invite", async () => {
    const select = vi.fn().mockImplementationOnce(membershipSelect("admin"));
    const deleteWhere = vi.fn(async () => undefined);
    const deleteFn = vi.fn(() => ({ where: deleteWhere }));
    const server = await startTeams({ select, delete: deleteFn });
    const res = await server.inject({
      method: "DELETE",
      url: `/api/me/teams/${TEAM_ID}/invites/00000000-0000-4000-8000-0000000000c1`,
      headers: authed,
    });
    expect(res.statusCode).toBe(204);
    expect(deleteFn).toHaveBeenCalledOnce();
  });

  it("blocks a member from revoking an invite", async () => {
    const select = vi.fn().mockImplementationOnce(membershipSelect("member"));
    const deleteFn = vi.fn();
    const server = await startTeams({ select, delete: deleteFn });
    const res = await server.inject({
      method: "DELETE",
      url: `/api/me/teams/${TEAM_ID}/invites/00000000-0000-4000-8000-0000000000c1`,
      headers: authed,
    });
    expect(res.statusCode).toBe(403);
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("resends an invite email", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  email: "new@acme.io",
                  role: "member",
                  tokenValue: "tok_resend",
                  teamName: "Acme Mobile",
                },
              ]),
            })),
          })),
        })),
      }));
    const server = await startTeams({ select });
    const res = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/invites/00000000-0000-4000-8000-0000000000c1/resend`,
      headers: authed,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ emailSent: true });
    expect(sendInviteEmailMock).toHaveBeenCalledOnce();
  });

  it("404s resending a non-existent invite", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
          })),
        })),
      }));
    const server = await startTeams({ select });
    const res = await server.inject({
      method: "POST",
      url: `/api/me/teams/${TEAM_ID}/invites/00000000-0000-4000-8000-0000000000c1/resend`,
      headers: authed,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "invite_not_found" });
  });

  it("409s accepting an already-accepted invite", async () => {
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            {
              id: "00000000-0000-4000-8000-0000000000c9",
              teamId: TEAM_ID,
              email: "user@example.com",
              role: "member",
              expiresAt: new Date(Date.now() + 86_400_000),
              acceptedAt: new Date("2026-06-09T00:00:00.000Z"),
            },
          ]),
        })),
      })),
    }));
    const server = await startTeams({ select, insert: vi.fn() });
    const res = await server.inject({
      method: "POST",
      url: "/api/invites/tok_abc/accept",
      headers: authed,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "invite_already_accepted" });
  });

  it("403s changing the owner's role", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(targetMemberSelect("owner"));
    const server = await startTeams({ select, update: vi.fn() });
    const res = await server.inject({
      method: "PATCH",
      url: `/api/me/teams/${TEAM_ID}/members/00000000-0000-4000-8000-0000000000b9`,
      headers: authed,
      payload: { role: "member" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "cannot_change_owner" });
  });

  it("404s changing the role of a non-member", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
      }));
    const server = await startTeams({ select, update: vi.fn() });
    const res = await server.inject({
      method: "PATCH",
      url: `/api/me/teams/${TEAM_ID}/members/00000000-0000-4000-8000-0000000000b9`,
      headers: authed,
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "member_not_found" });
  });

  it("403s removing the owner", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("owner"))
      .mockImplementationOnce(targetMemberSelect("owner"));
    const server = await startTeams({ select, delete: vi.fn() });
    const res = await server.inject({
      method: "DELETE",
      url: `/api/me/teams/${TEAM_ID}/members/00000000-0000-4000-8000-0000000000b9`,
      headers: authed,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "cannot_remove_owner" });
  });

  it("400s leaving the personal team", async () => {
    // teamId === userId resolves to the personal context without any query.
    const select = vi.fn();
    const server = await startTeams({ select, delete: vi.fn() });
    const res = await server.inject({
      method: "POST",
      url: `/api/me/teams/${userId}/leave`,
      headers: authed,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "cannot_leave_personal" });
    expect(select).not.toHaveBeenCalled();
  });

  it("403s renaming or deleting a team as an admin", async () => {
    const renameServer = await startTeams({
      select: vi.fn().mockImplementationOnce(membershipSelect("admin")),
      update: vi.fn(),
    });
    const rename = await renameServer.inject({
      method: "PATCH",
      url: `/api/me/teams/${TEAM_ID}`,
      headers: authed,
      payload: { name: "Nope" },
    });
    expect(rename.statusCode).toBe(403);

    const deleteServer = await startTeams({
      select: vi.fn().mockImplementationOnce(membershipSelect("admin")),
      delete: vi.fn(),
    });
    const del = await deleteServer.inject({
      method: "DELETE",
      url: `/api/me/teams/${TEAM_ID}`,
      headers: authed,
    });
    expect(del.statusCode).toBe(403);
  });
});
