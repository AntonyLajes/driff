import type { FastifyInstance } from "fastify";

import {
  execute as loadSystemReadiness,
  type SystemReadiness,
} from "@/analytics/load-system-readiness.js";
import { verifySessionJwt } from "@/auth/session-jwt.js";
import type { Database } from "@/db/client.js";
import { readTeamIdHeader, resolveTeamContext } from "@/teams/team-context.js";

export interface SystemReadinessMeRegistrationInput {
  db: Database;
  jwtSecret: string;
  readinessLoader?: (input: {
    db: Database;
    teamId: string;
  }) => Promise<SystemReadiness>;
}

const readBearerToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

export const handler = async (
  instance: FastifyInstance,
  input: SystemReadinessMeRegistrationInput,
): Promise<void> => {
  instance.get("/api/me/system-readiness", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const team = await resolveTeamContext(
      input.db,
      session.userId,
      readTeamIdHeader(request.headers),
    );
    if (team.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (team.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }

    const readiness = await (input.readinessLoader ?? loadSystemReadiness)({
      db: input.db,
      teamId: team.context.teamId,
    });
    return reply.send({ readiness });
  });
};
