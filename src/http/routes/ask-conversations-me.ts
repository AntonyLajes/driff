import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  askConversationWriteSchema,
  execute as createConversationStore,
  type AskConversationStore,
} from "@/ask/conversation-store.js";
import { verifySessionJwt } from "@/auth/session-jwt.js";
import type { Database } from "@/db/client.js";
import { workspacesTable } from "@/db/schema.js";
import { normalizeWorkspaceSlug } from "@/lib/workspace-slug.js";
import { readTeamIdHeader, resolveTeamContext } from "@/teams/team-context.js";
import { workspaceVisibilityCondition } from "@/workspaces/member-access.js";

const paramsSchema = z.object({
  slug: z.string(),
  conversationId: z.string().uuid().optional(),
});

type WorkspaceAccessResult =
  | { kind: "invalid_team" | "not_a_member" | "invalid_slug" | "not_found" }
  | { kind: "ok"; workspaceId: string };

type ResolveWorkspace = (input: {
  userId: string;
  requestedTeamId: string | undefined;
  slug: string;
}) => Promise<WorkspaceAccessResult>;

export interface AskConversationsMeRegistrationInput {
  db: Database;
  jwtSecret: string;
  store?: AskConversationStore;
  resolveWorkspace?: ResolveWorkspace;
}

const readBearerToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

const sendAccessError = (
  result: Exclude<WorkspaceAccessResult, { kind: "ok" }>,
  reply: FastifyReply,
) => {
  if (result.kind === "invalid_team") {
    return reply.status(400).send({ error: "invalid_team" });
  }
  if (result.kind === "not_a_member") {
    return reply.status(403).send({ error: "not_a_team_member" });
  }
  if (result.kind === "invalid_slug") {
    return reply.status(400).send({ error: "invalid_workspace_slug" });
  }
  return reply.status(404).send({ error: "workspace_not_found" });
};

const defaultWorkspaceResolver =
  (db: Database): ResolveWorkspace =>
  async ({ userId, requestedTeamId, slug }) => {
    const normalizedSlug = normalizeWorkspaceSlug(slug);
    if (
      normalizedSlug.length === 0 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)
    ) {
      return { kind: "invalid_slug" };
    }
    const team = await resolveTeamContext(db, userId, requestedTeamId);
    if (team.kind !== "ok") return { kind: team.kind };
    const rows = await db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(
        and(
          eq(workspacesTable.teamId, team.context.teamId),
          eq(workspacesTable.slug, normalizedSlug),
          workspaceVisibilityCondition({ userId, role: team.context.role }),
        ),
      )
      .limit(1);
    return rows[0] === undefined
      ? { kind: "not_found" }
      : { kind: "ok", workspaceId: rows[0].id };
  };

export const handler = async (
  instance: FastifyInstance,
  input: AskConversationsMeRegistrationInput,
): Promise<void> => {
  const store = input.store ?? createConversationStore({ db: input.db });
  const resolveWorkspace =
    input.resolveWorkspace ?? defaultWorkspaceResolver(input.db);

  const authorize = async (request: {
    headers: {
      authorization?: string;
      "x-team-id"?: string;
    };
    params: unknown;
  }) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) return { kind: "unauthorized" as const };
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) return { kind: "invalid_session" as const };
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return { kind: "invalid_params" as const };
    const access = await resolveWorkspace({
      userId: session.userId,
      requestedTeamId: readTeamIdHeader(request.headers),
      slug: params.data.slug,
    });
    return { kind: "resolved" as const, session, params: params.data, access };
  };

  const requireAccess = async (
    request: Parameters<typeof authorize>[0],
    reply: FastifyReply,
  ) => {
    const auth = await authorize(request);
    if (auth.kind === "unauthorized") {
      reply.status(401).send({ error: "missing_or_invalid_authorization" });
      return null;
    }
    if (auth.kind === "invalid_session") {
      reply.status(401).send({ error: "invalid_session" });
      return null;
    }
    if (auth.kind === "invalid_params") {
      reply.status(400).send({ error: "invalid_params" });
      return null;
    }
    if (auth.access.kind !== "ok") {
      sendAccessError(auth.access, reply);
      return null;
    }
    return { ...auth, access: auth.access };
  };

  instance.get(
    "/api/me/workspaces/by-slug/:slug/ask/conversations",
    async (request, reply) => {
      const auth = await requireAccess(request, reply);
      if (auth === null) return reply;
      const conversations = await store.list({
        workspaceId: auth.access.workspaceId,
        userId: auth.session.userId,
      });
      return reply.send({ conversations });
    },
  );

  instance.put(
    "/api/me/workspaces/by-slug/:slug/ask/conversations/:conversationId",
    async (request, reply) => {
      const auth = await requireAccess(request, reply);
      if (auth === null) return reply;
      const body = askConversationWriteSchema.safeParse(request.body);
      if (!body.success || auth.params.conversationId === undefined) {
        return reply.status(400).send({ error: "invalid_ask_conversation" });
      }
      const conversation = await store.upsert({
        id: auth.params.conversationId,
        workspaceId: auth.access.workspaceId,
        userId: auth.session.userId,
        ...body.data,
      });
      if (conversation === null) {
        return reply.status(404).send({ error: "ask_conversation_not_found" });
      }
      return reply.send({ conversation });
    },
  );

  instance.get(
    "/api/me/workspaces/by-slug/:slug/ask/conversations/shared/:conversationId",
    async (request, reply) => {
      const auth = await requireAccess(request, reply);
      if (auth === null) return reply;
      if (auth.params.conversationId === undefined) {
        return reply.status(400).send({ error: "invalid_ask_conversation" });
      }
      const conversation = await store.findShared({
        id: auth.params.conversationId,
        workspaceId: auth.access.workspaceId,
      });
      return conversation === null
        ? reply.status(404).send({ error: "ask_conversation_not_found" })
        : reply.send({ conversation });
    },
  );

  instance.post(
    "/api/me/workspaces/by-slug/:slug/ask/conversations/:conversationId/share",
    async (request, reply) => {
      const auth = await requireAccess(request, reply);
      if (auth === null) return reply;
      if (auth.params.conversationId === undefined) {
        return reply.status(400).send({ error: "invalid_ask_conversation" });
      }
      const conversation = await store.setShared({
        id: auth.params.conversationId,
        workspaceId: auth.access.workspaceId,
        userId: auth.session.userId,
        shared: true,
      });
      return conversation === null
        ? reply.status(404).send({ error: "ask_conversation_not_found" })
        : reply.send({ conversation });
    },
  );

  instance.delete(
    "/api/me/workspaces/by-slug/:slug/ask/conversations/:conversationId/share",
    async (request, reply) => {
      const auth = await requireAccess(request, reply);
      if (auth === null) return reply;
      if (auth.params.conversationId === undefined) {
        return reply.status(400).send({ error: "invalid_ask_conversation" });
      }
      const conversation = await store.setShared({
        id: auth.params.conversationId,
        workspaceId: auth.access.workspaceId,
        userId: auth.session.userId,
        shared: false,
      });
      return conversation === null
        ? reply.status(404).send({ error: "ask_conversation_not_found" })
        : reply.send({ conversation });
    },
  );

  instance.delete(
    "/api/me/workspaces/by-slug/:slug/ask/conversations/:conversationId",
    async (request, reply) => {
      const auth = await requireAccess(request, reply);
      if (auth === null) return reply;
      if (auth.params.conversationId === undefined) {
        return reply.status(400).send({ error: "invalid_ask_conversation" });
      }
      const removed = await store.remove({
        id: auth.params.conversationId,
        workspaceId: auth.access.workspaceId,
        userId: auth.session.userId,
      });
      return removed
        ? reply.status(204).send()
        : reply.status(404).send({ error: "ask_conversation_not_found" });
    },
  );
};
