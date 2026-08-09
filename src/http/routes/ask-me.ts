import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  execute as searchHistory,
  type ExecuteInput as SearchHistoryInput,
} from "@/ask/search-history.js";
import { verifySessionJwt } from "@/auth/session-jwt.js";
import type { Database } from "@/db/client.js";
import { workspacesTable } from "@/db/schema.js";
import { normalizeWorkspaceSlug } from "@/lib/workspace-slug.js";
import { readTeamIdHeader, resolveTeamContext } from "@/teams/team-context.js";

const askBodySchema = z.object({
  question: z.string().trim().min(3).max(500),
});

export interface AskMeRegistrationInput {
  db: Database;
  jwtSecret: string;
  historySearcher?: (
    input: SearchHistoryInput,
  ) => Promise<Awaited<ReturnType<typeof searchHistory>>>;
}

const readBearerToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

export const handler = async (
  instance: FastifyInstance,
  input: AskMeRegistrationInput,
): Promise<void> => {
  instance.post(
    "/api/me/workspaces/by-slug/:slug/ask",
    async (request, reply) => {
      const token = readBearerToken(request.headers.authorization);
      if (token === null) {
        return reply
          .status(401)
          .send({ error: "missing_or_invalid_authorization" });
      }
      const session = verifySessionJwt(token, input.jwtSecret);
      if (session === null) {
        return reply.status(401).send({ error: "invalid_session" });
      }

      const bodyParsed = askBodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: "invalid_ask_question" });
      }

      const params = request.params as { slug?: string };
      const slug = normalizeWorkspaceSlug(params.slug ?? "");
      if (slug.length === 0 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
        return reply.status(400).send({ error: "invalid_workspace_slug" });
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

      const workspaceRows = await input.db
        .select({
          id: workspacesTable.id,
          name: workspacesTable.name,
          slug: workspacesTable.slug,
        })
        .from(workspacesTable)
        .where(
          and(
            eq(workspacesTable.teamId, team.context.teamId),
            eq(workspacesTable.slug, slug),
          ),
        )
        .limit(1);
      const workspace = workspaceRows[0];
      if (workspace === undefined) {
        return reply.status(404).send({ error: "workspace_not_found" });
      }

      const result = await (input.historySearcher ?? searchHistory)({
        db: input.db,
        workspaceId: workspace.id,
        question: bodyParsed.data.question,
      });

      return reply.send({ workspace, question: bodyParsed.data.question, ...result });
    },
  );
};
