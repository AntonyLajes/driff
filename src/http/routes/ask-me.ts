import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  execute as searchHistory,
  type ExecuteInput as SearchHistoryInput,
} from "@/ask/search-history.js";
import type {
  ComposeAnswerInput,
  ComposedAnswer,
} from "@/ask/compose-answer.js";
import { execute as resolveCasualMessage } from "@/ask/resolve-casual-message.js";
import { execute as resolveFollowUp } from "@/ask/resolve-follow-up.js";
import { verifySessionJwt } from "@/auth/session-jwt.js";
import type { Database } from "@/db/client.js";
import { askInteractionsTable, workspacesTable } from "@/db/schema.js";
import { normalizeWorkspaceSlug } from "@/lib/workspace-slug.js";
import { recordLlmUsage, type TokenUsage } from "@/llm/usage.js";
import { readTeamIdHeader, resolveTeamContext } from "@/teams/team-context.js";
import { workspaceVisibilityCondition } from "@/workspaces/member-access.js";

const askBodySchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/[\p{Letter}\p{Number}]/u),
  conversation: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(2_000),
      }),
    )
    .max(8)
    .optional()
    .default([]),
});

const feedbackBodySchema = z.object({
  value: z.enum(["helpful", "unhelpful"]),
});

export interface AskMeRegistrationInput {
  db: Database;
  jwtSecret: string;
  historySearcher?: (
    input: SearchHistoryInput,
  ) => Promise<Awaited<ReturnType<typeof searchHistory>>>;
  answerComposer?: (input: ComposeAnswerInput) => Promise<ComposedAnswer>;
  usageRecorder?: (input: {
    repo: string;
    usage: TokenUsage;
  }) => Promise<void>;
  interactionRecorder?: (input: {
    workspaceId: string;
    hadEvidence: boolean;
  }) => Promise<string | null>;
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
  const recordInteraction =
    input.interactionRecorder ??
    (async (interaction: {
      workspaceId: string;
      hadEvidence: boolean;
    }): Promise<string | null> => {
      const rows = await input.db
        .insert(askInteractionsTable)
        .values(interaction)
        .returning({ id: askInteractionsTable.id });
      return rows[0]?.id ?? null;
    });

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
          repoFullName: workspacesTable.repoFullName,
        })
        .from(workspacesTable)
        .where(
          and(
            eq(workspacesTable.teamId, team.context.teamId),
            eq(workspacesTable.slug, slug),
            workspaceVisibilityCondition({ userId: session.userId, role: team.context.role }),
          ),
        )
        .limit(1);
      const workspace = workspaceRows[0];
      if (workspace === undefined) {
        return reply.status(404).send({ error: "workspace_not_found" });
      }

      const casualMessage = resolveCasualMessage(bodyParsed.data.question);
      if (casualMessage !== null) {
        return reply.send({
          workspace: {
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
          },
          question: bodyParsed.data.question,
          answerText: casualMessage.answerText,
          interactionId: null,
          status: "no_evidence",
          mode: "change",
          confidence: "none",
          queryTerms: [],
          period: null,
          totalMatches: 0,
          hasMore: false,
          version: null,
          matches: [],
        });
      }

      const result = await (input.historySearcher ?? searchHistory)({
        db: input.db,
        workspaceId: workspace.id,
        question: resolveFollowUp({
          question: bodyParsed.data.question,
          conversation: bodyParsed.data.conversation,
        }),
      });

      let answerText: string | null = null;
      if (input.answerComposer !== undefined) {
        try {
          const composed = await input.answerComposer({
            question: bodyParsed.data.question,
            conversation: bodyParsed.data.conversation,
            retrieval: result,
          });
          answerText = composed.answerText;
          await (input.usageRecorder ??
            (async ({ repo, usage }) =>
              recordLlmUsage({
                db: input.db,
                repo,
                jobType: "ask",
                usage,
              })))(
            {
              repo: workspace.repoFullName ?? workspace.slug,
              usage: composed.usage,
            },
          );
        } catch (error) {
          // Retrieval remains useful when conversational composition is unavailable.
          request.log.warn(
            { error, workspaceId: workspace.id },
            "ask_answer_composition_failed",
          );
        }
      }

      let interactionId: string | null = null;
      try {
        interactionId = await recordInteraction({
          workspaceId: workspace.id,
          hadEvidence: result.status === "answered" && result.matches.length > 0,
        });
      } catch (error) {
        // Product analytics must never make the evidence search unavailable.
        request.log.warn({ error, workspaceId: workspace.id }, "ask_interaction_record_failed");
      }

      return reply.send({
        workspace: {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
        },
        question: bodyParsed.data.question,
        answerText,
        interactionId,
        ...result,
      });
    },
  );

  instance.patch(
    "/api/me/workspaces/by-slug/:slug/ask/:interactionId/feedback",
    async (request, reply) => {
      const token = readBearerToken(request.headers.authorization);
      if (token === null) {
        return reply.status(401).send({ error: "missing_or_invalid_authorization" });
      }
      const session = verifySessionJwt(token, input.jwtSecret);
      if (session === null) {
        return reply.status(401).send({ error: "invalid_session" });
      }

      const bodyParsed = feedbackBodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: "invalid_ask_feedback" });
      }
      const params = request.params as {
        slug?: string;
        interactionId?: string;
      };
      const interactionId = z.string().uuid().safeParse(params.interactionId);
      const slug = normalizeWorkspaceSlug(params.slug ?? "");
      if (
        !interactionId.success ||
        slug.length === 0 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
      ) {
        return reply.status(400).send({ error: "invalid_ask_feedback_target" });
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
        .select({ id: workspacesTable.id })
        .from(workspacesTable)
        .where(
          and(
            eq(workspacesTable.teamId, team.context.teamId),
            eq(workspacesTable.slug, slug),
            workspaceVisibilityCondition({ userId: session.userId, role: team.context.role }),
          ),
        )
        .limit(1);
      const workspace = workspaceRows[0];
      if (workspace === undefined) {
        return reply.status(404).send({ error: "workspace_not_found" });
      }

      const updated = await input.db
        .update(askInteractionsTable)
        .set({
          feedback: bodyParsed.data.value,
          feedbackAt: new Date(),
        })
        .where(
          and(
            eq(askInteractionsTable.id, interactionId.data),
            eq(askInteractionsTable.workspaceId, workspace.id),
          ),
        )
        .returning({ id: askInteractionsTable.id });
      if (updated[0] === undefined) {
        return reply.status(404).send({ error: "ask_interaction_not_found" });
      }
      return reply.send({ feedback: bodyParsed.data.value });
    },
  );
};
