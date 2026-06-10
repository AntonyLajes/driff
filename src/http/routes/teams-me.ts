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
import { slugifyWorkspaceName } from "@/lib/workspace-slug.js";
import { resolveTeamContext, type TeamRole } from "@/teams/team-context.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createTeamBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

const randomSlugSuffix = (): string =>
  Math.random().toString(36).slice(2, 8);

export interface TeamsMeRegistrationInput {
  db: Database;
  jwtSecret: string;
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

  /** Resolves membership for a path `:teamId`; 400/403/404 on failure. */
  const requireMembership = async (
    reply: FastifyReply,
    userId: string,
    teamId: string,
  ): Promise<TeamRole | null> => {
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
    return result.context.role;
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
