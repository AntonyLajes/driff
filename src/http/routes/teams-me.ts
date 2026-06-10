import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { verifySessionJwt } from "@/auth/session-jwt.js";
import type { Database } from "@/db/client.js";
import {
  teamInvitesTable,
  teamMembersTable,
  teamsTable,
  usersTable,
} from "@/db/schema.js";
import { sendInviteEmail } from "@/email/send-invite-email.js";
import { slugifyWorkspaceName } from "@/lib/workspace-slug.js";
import {
  canManageAdmins,
  canManageMembers,
  canManageTeam,
  resolveTeamContext,
  type TeamContext,
  type TeamRole,
} from "@/teams/team-context.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createTeamBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

const inviteBodySchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(["admin", "member"]),
});

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const randomSlugSuffix = (): string =>
  Math.random().toString(36).slice(2, 8);

export interface TeamsMeRegistrationInput {
  db: Database;
  jwtSecret: string;
  /** Resend config (optional — invites fall back to a copyable link). */
  resendApiKey?: string;
  resendFrom?: string;
  /** Web app origin for the accept link (e.g. https://app.driff.dev). */
  frontendUrl?: string;
}

const readBearerToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

/** Teams the session user belongs to, with their role and member counts. */
export const handler = async (
  instance: FastifyInstance,
  input: TeamsMeRegistrationInput,
): Promise<void> => {
  instance.get("/api/me/teams", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const rows = await input.db
      .select({
        id: teamsTable.id,
        name: teamsTable.name,
        slug: teamsTable.slug,
        isPersonal: teamsTable.isPersonal,
        maxMembers: teamsTable.maxMembers,
        role: teamMembersTable.role,
        createdAt: teamsTable.createdAt,
      })
      .from(teamMembersTable)
      .innerJoin(teamsTable, eq(teamsTable.id, teamMembersTable.teamId))
      .where(eq(teamMembersTable.userId, session.userId));

    if (rows.length === 0) {
      return reply.send({ teams: [] });
    }

    const counts = await input.db
      .select({ teamId: teamMembersTable.teamId, value: count() })
      .from(teamMembersTable)
      .where(
        inArray(
          teamMembersTable.teamId,
          rows.map((row) => row.id),
        ),
      )
      .groupBy(teamMembersTable.teamId);
    const countByTeam = new Map(counts.map((row) => [row.teamId, row.value]));

    const teams = rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        isPersonal: row.isPersonal,
        maxMembers: row.maxMembers,
        role: row.role as TeamRole,
        memberCount: countByTeam.get(row.id) ?? 1,
        createdAt: row.createdAt.toISOString(),
      }))
      // Personal team first, then alphabetically.
      .sort((a, b) =>
        a.isPersonal !== b.isPersonal
          ? Number(b.isPersonal) - Number(a.isPersonal)
          : a.name.localeCompare(b.name),
      );

    return reply.send({ teams });
  });

  /** Resolves the team context for a path `:teamId`; 400/403 on failure. */
  const requireContext = async (
    reply: FastifyReply,
    userId: string,
    teamId: string,
  ): Promise<TeamContext | null> => {
    if (!uuidPattern.test(teamId)) {
      void reply.status(400).send({ error: "invalid_team" });
      return null;
    }
    const result = await resolveTeamContext(input.db, userId, teamId);
    if (result.kind === "invalid_team") {
      void reply.status(400).send({ error: "invalid_team" });
      return null;
    }
    if (result.kind === "not_a_member") {
      void reply.status(403).send({ error: "not_a_team_member" });
      return null;
    }
    return result.context;
  };

  /** Convenience for handlers that only need the role. */
  const requireMembership = async (
    reply: FastifyReply,
    userId: string,
    teamId: string,
  ): Promise<TeamRole | null> => {
    const ctx = await requireContext(reply, userId, teamId);
    return ctx === null ? null : ctx.role;
  };

  instance.get("/api/me/teams/:teamId/members", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const { teamId } = request.params as { teamId: string };
    const role = await requireMembership(reply, session.userId, teamId);
    if (role === null) return reply;

    const rows = await input.db
      .select({
        userId: teamMembersTable.userId,
        role: teamMembersTable.role,
        createdAt: teamMembersTable.createdAt,
        name: usersTable.name,
        email: usersTable.email,
        picture: usersTable.picture,
      })
      .from(teamMembersTable)
      .innerJoin(usersTable, eq(usersTable.id, teamMembersTable.userId))
      .where(eq(teamMembersTable.teamId, teamId))
      .orderBy(asc(teamMembersTable.createdAt));

    const rank: Record<string, number> = { owner: 0, admin: 1, member: 2 };
    const members = rows
      .map((row) => ({
        userId: row.userId,
        name: row.name,
        email: row.email,
        picture: row.picture,
        role: row.role as TeamRole,
        isYou: row.userId === session.userId,
        joinedAt: row.createdAt.toISOString(),
      }))
      .sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9));

    return reply.send({ members, yourRole: role });
  });

  instance.get("/api/me/teams/:teamId/invites", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const { teamId } = request.params as { teamId: string };
    const role = await requireMembership(reply, session.userId, teamId);
    if (role === null) return reply;

    const rows = await input.db
      .select({
        id: teamInvitesTable.id,
        email: teamInvitesTable.email,
        role: teamInvitesTable.role,
        expiresAt: teamInvitesTable.expiresAt,
        createdAt: teamInvitesTable.createdAt,
      })
      .from(teamInvitesTable)
      .where(
        and(eq(teamInvitesTable.teamId, teamId), isNull(teamInvitesTable.acceptedAt)),
      )
      .orderBy(asc(teamInvitesTable.createdAt));

    return reply.send({
      invites: rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role as TeamRole,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
    });
  });

  const acceptUrl = (token: string): string =>
    `${(input.frontendUrl ?? "").replace(/\/+$/, "")}/invite/${token}`;

  const dispatchInviteEmail = (params: {
    to: string;
    teamName: string;
    inviterName: string;
    role: string;
    token: string;
  }) =>
    sendInviteEmail({
      apiKey: input.resendApiKey,
      from: input.resendFrom,
      to: params.to,
      teamName: params.teamName,
      inviterName: params.inviterName,
      role: params.role,
      acceptUrl: acceptUrl(params.token),
    });

  instance.post("/api/me/teams/:teamId/invites", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const { teamId } = request.params as { teamId: string };
    const role = await requireMembership(reply, session.userId, teamId);
    if (role === null) return reply;
    if (!canManageMembers(role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }
    const parsed = inviteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body" });
    }
    const email = parsed.data.email.toLowerCase();

    const teamRows = await input.db
      .select({ name: teamsTable.name, maxMembers: teamsTable.maxMembers })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1);
    const team = teamRows[0];
    if (team === undefined) {
      return reply.status(404).send({ error: "team_not_found" });
    }

    const memberEmails = await input.db
      .select({ email: usersTable.email })
      .from(teamMembersTable)
      .innerJoin(usersTable, eq(usersTable.id, teamMembersTable.userId))
      .where(eq(teamMembersTable.teamId, teamId));
    const pendingInvites = await input.db
      .select({ email: teamInvitesTable.email })
      .from(teamInvitesTable)
      .where(
        and(eq(teamInvitesTable.teamId, teamId), isNull(teamInvitesTable.acceptedAt)),
      );

    if (memberEmails.length + pendingInvites.length >= team.maxMembers) {
      return reply.status(409).send({ error: "seat_limit_reached" });
    }
    if (memberEmails.some((row) => row.email.toLowerCase() === email)) {
      return reply.status(409).send({ error: "already_member" });
    }
    if (pendingInvites.some((row) => row.email.toLowerCase() === email)) {
      return reply.status(409).send({ error: "invite_exists" });
    }

    const inviteToken = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const inserted = await input.db
      .insert(teamInvitesTable)
      .values({
        teamId,
        email,
        role: parsed.data.role,
        token: inviteToken,
        invitedByUserId: session.userId,
        expiresAt,
      })
      .returning({
        id: teamInvitesTable.id,
        email: teamInvitesTable.email,
        role: teamInvitesTable.role,
        expiresAt: teamInvitesTable.expiresAt,
        createdAt: teamInvitesTable.createdAt,
      });
    const invite = inserted[0];
    if (invite === undefined) {
      return reply.status(500).send({ error: "insert_failed" });
    }

    const emailResult = await dispatchInviteEmail({
      to: email,
      teamName: team.name,
      inviterName: session.email,
      role: parsed.data.role,
      token: inviteToken,
    });

    return reply.status(201).send({
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role as TeamRole,
        expiresAt: invite.expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
      },
      acceptUrl: acceptUrl(inviteToken),
      emailSent: emailResult.sent,
    });
  });

  instance.delete("/api/me/teams/:teamId/invites/:inviteId", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const { teamId, inviteId } = request.params as { teamId: string; inviteId: string };
    const role = await requireMembership(reply, session.userId, teamId);
    if (role === null) return reply;
    if (!canManageMembers(role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }
    if (!uuidPattern.test(inviteId)) {
      return reply.status(400).send({ error: "invalid_invite" });
    }
    await input.db
      .delete(teamInvitesTable)
      .where(
        and(eq(teamInvitesTable.id, inviteId), eq(teamInvitesTable.teamId, teamId)),
      );
    return reply.status(204).send();
  });

  instance.post(
    "/api/me/teams/:teamId/invites/:inviteId/resend",
    async (request, reply) => {
      const token = readBearerToken(request.headers.authorization);
      if (token === null) {
        return reply.status(401).send({ error: "missing_or_invalid_authorization" });
      }
      const session = verifySessionJwt(token, input.jwtSecret);
      if (session === null) {
        return reply.status(401).send({ error: "invalid_session" });
      }
      const { teamId, inviteId } = request.params as { teamId: string; inviteId: string };
      const role = await requireMembership(reply, session.userId, teamId);
      if (role === null) return reply;
      if (!canManageMembers(role)) {
        return reply.status(403).send({ error: "insufficient_role" });
      }
      if (!uuidPattern.test(inviteId)) {
        return reply.status(400).send({ error: "invalid_invite" });
      }
      const rows = await input.db
        .select({
          email: teamInvitesTable.email,
          role: teamInvitesTable.role,
          tokenValue: teamInvitesTable.token,
          teamName: teamsTable.name,
        })
        .from(teamInvitesTable)
        .innerJoin(teamsTable, eq(teamsTable.id, teamInvitesTable.teamId))
        .where(
          and(
            eq(teamInvitesTable.id, inviteId),
            eq(teamInvitesTable.teamId, teamId),
            isNull(teamInvitesTable.acceptedAt),
          ),
        )
        .limit(1);
      const invite = rows[0];
      if (invite === undefined) {
        return reply.status(404).send({ error: "invite_not_found" });
      }
      const emailResult = await dispatchInviteEmail({
        to: invite.email,
        teamName: invite.teamName,
        inviterName: session.email,
        role: invite.role,
        token: invite.tokenValue,
      });
      return reply.send({
        acceptUrl: acceptUrl(invite.tokenValue),
        emailSent: emailResult.sent,
      });
    },
  );

  instance.get("/api/invites/:token", async (request, reply) => {
    const { token: inviteToken } = request.params as { token: string };
    const rows = await input.db
      .select({
        email: teamInvitesTable.email,
        role: teamInvitesTable.role,
        expiresAt: teamInvitesTable.expiresAt,
        acceptedAt: teamInvitesTable.acceptedAt,
        teamName: teamsTable.name,
      })
      .from(teamInvitesTable)
      .innerJoin(teamsTable, eq(teamsTable.id, teamInvitesTable.teamId))
      .where(eq(teamInvitesTable.token, inviteToken))
      .limit(1);
    const invite = rows[0];
    if (invite === undefined) {
      return reply.status(404).send({ error: "invite_not_found" });
    }
    const expired = invite.expiresAt.getTime() < Date.now();
    return reply.send({
      invite: {
        teamName: invite.teamName,
        role: invite.role as TeamRole,
        email: invite.email,
        expired,
        accepted: invite.acceptedAt !== null,
      },
    });
  });

  instance.post("/api/invites/:token/accept", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const { token: inviteToken } = request.params as { token: string };
    const rows = await input.db
      .select({
        id: teamInvitesTable.id,
        teamId: teamInvitesTable.teamId,
        email: teamInvitesTable.email,
        role: teamInvitesTable.role,
        expiresAt: teamInvitesTable.expiresAt,
        acceptedAt: teamInvitesTable.acceptedAt,
      })
      .from(teamInvitesTable)
      .where(eq(teamInvitesTable.token, inviteToken))
      .limit(1);
    const invite = rows[0];
    if (invite === undefined) {
      return reply.status(404).send({ error: "invite_not_found" });
    }
    if (invite.acceptedAt !== null) {
      return reply.status(409).send({ error: "invite_already_accepted" });
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      return reply.status(410).send({ error: "invite_expired" });
    }
    if (invite.email.toLowerCase() !== session.email.toLowerCase()) {
      return reply.status(403).send({ error: "invite_email_mismatch" });
    }

    await input.db
      .insert(teamMembersTable)
      .values({ teamId: invite.teamId, userId: session.userId, role: invite.role })
      .onConflictDoNothing();
    await input.db
      .update(teamInvitesTable)
      .set({ acceptedAt: new Date() })
      .where(eq(teamInvitesTable.id, invite.id));

    return reply.send({ teamId: invite.teamId });
  });

  const loadMembership = async (teamId: string, targetUserId: string) => {
    const rows = await input.db
      .select({ role: teamMembersTable.role })
      .from(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.teamId, teamId),
          eq(teamMembersTable.userId, targetUserId),
        ),
      )
      .limit(1);
    return rows[0];
  };

  instance.patch("/api/me/teams/:teamId/members/:userId", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const { teamId, userId: targetId } = request.params as {
      teamId: string;
      userId: string;
    };
    const role = await requireMembership(reply, session.userId, teamId);
    if (role === null) return reply;
    // Promoting/demoting (the only roles touch admin) is owner-only.
    if (!canManageAdmins(role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }
    const parsed = z
      .object({ role: z.enum(["admin", "member"]) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body" });
    }
    const target = await loadMembership(teamId, targetId);
    if (target === undefined) {
      return reply.status(404).send({ error: "member_not_found" });
    }
    if (target.role === "owner") {
      return reply.status(403).send({ error: "cannot_change_owner" });
    }
    await input.db
      .update(teamMembersTable)
      .set({ role: parsed.data.role })
      .where(
        and(eq(teamMembersTable.teamId, teamId), eq(teamMembersTable.userId, targetId)),
      );
    return reply.send({ userId: targetId, role: parsed.data.role });
  });

  instance.delete("/api/me/teams/:teamId/members/:userId", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const { teamId, userId: targetId } = request.params as {
      teamId: string;
      userId: string;
    };
    const role = await requireMembership(reply, session.userId, teamId);
    if (role === null) return reply;
    if (!canManageMembers(role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }
    const target = await loadMembership(teamId, targetId);
    if (target === undefined) {
      return reply.status(404).send({ error: "member_not_found" });
    }
    if (target.role === "owner") {
      return reply.status(403).send({ error: "cannot_remove_owner" });
    }
    // Admins manage members only; removing another admin is owner-only.
    if (target.role === "admin" && !canManageAdmins(role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }
    await input.db
      .delete(teamMembersTable)
      .where(
        and(eq(teamMembersTable.teamId, teamId), eq(teamMembersTable.userId, targetId)),
      );
    return reply.status(204).send();
  });

  instance.post("/api/me/teams/:teamId/leave", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const { teamId } = request.params as { teamId: string };
    const ctx = await requireContext(reply, session.userId, teamId);
    if (ctx === null) return reply;
    if (ctx.isPersonal) {
      return reply.status(400).send({ error: "cannot_leave_personal" });
    }
    if (ctx.role === "owner") {
      const [owners] = await input.db
        .select({ value: count() })
        .from(teamMembersTable)
        .where(
          and(eq(teamMembersTable.teamId, teamId), eq(teamMembersTable.role, "owner")),
        );
      if ((owners?.value ?? 0) <= 1) {
        return reply.status(409).send({ error: "last_owner" });
      }
    }
    await input.db
      .delete(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.teamId, teamId),
          eq(teamMembersTable.userId, session.userId),
        ),
      );
    return reply.status(204).send();
  });

  instance.patch("/api/me/teams/:teamId", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const { teamId } = request.params as { teamId: string };
    const ctx = await requireContext(reply, session.userId, teamId);
    if (ctx === null) return reply;
    if (ctx.isPersonal || !canManageTeam(ctx.role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }
    const parsed = createTeamBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body" });
    }
    const updated = await input.db
      .update(teamsTable)
      .set({ name: parsed.data.name.trim(), updatedAt: new Date() })
      .where(eq(teamsTable.id, teamId))
      .returning({ id: teamsTable.id, name: teamsTable.name, slug: teamsTable.slug });
    const team = updated[0];
    if (team === undefined) {
      return reply.status(404).send({ error: "team_not_found" });
    }
    return reply.send({ team });
  });

  instance.delete("/api/me/teams/:teamId", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const { teamId } = request.params as { teamId: string };
    const ctx = await requireContext(reply, session.userId, teamId);
    if (ctx === null) return reply;
    if (ctx.isPersonal || !canManageTeam(ctx.role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }
    // Members, invites and workspaces cascade via FK on team delete.
    await input.db.delete(teamsTable).where(eq(teamsTable.id, teamId));
    return reply.status(204).send();
  });

  const isUniqueViolation = (err: unknown): boolean =>
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505";

  instance.post("/api/me/teams", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const parsed = createTeamBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body" });
    }
    const name = parsed.data.name.trim();
    const baseSlug = slugifyWorkspaceName(name);

    // teams.slug is globally unique; retry with a random suffix on collision.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSlugSuffix()}`;
      try {
        const inserted = await input.db
          .insert(teamsTable)
          .values({ name, slug, isPersonal: false })
          .returning({
            id: teamsTable.id,
            name: teamsTable.name,
            slug: teamsTable.slug,
            isPersonal: teamsTable.isPersonal,
            maxMembers: teamsTable.maxMembers,
            createdAt: teamsTable.createdAt,
          });
        const team = inserted[0];
        if (team === undefined) {
          return reply.status(500).send({ error: "insert_failed" });
        }
        await input.db
          .insert(teamMembersTable)
          .values({ teamId: team.id, userId: session.userId, role: "owner" });
        return reply.status(201).send({
          team: {
            id: team.id,
            name: team.name,
            slug: team.slug,
            isPersonal: team.isPersonal,
            maxMembers: team.maxMembers,
            role: "owner" as TeamRole,
            memberCount: 1,
            createdAt: team.createdAt.toISOString(),
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          continue;
        }
        request.log.warn({ err }, "create_team_failed");
        return reply.status(500).send({ error: "internal_error" });
      }
    }
    return reply.status(409).send({ error: "team_slug_taken" });
  });
};
