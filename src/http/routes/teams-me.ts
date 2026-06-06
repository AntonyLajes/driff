import type { FastifyInstance } from "fastify";
import { count, eq, inArray } from "drizzle-orm";

import { verifySessionJwt } from "@/auth/session-jwt.js";
import type { Database } from "@/db/client.js";
import { teamMembersTable, teamsTable } from "@/db/schema.js";
import type { TeamRole } from "@/teams/team-context.js";

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
};
