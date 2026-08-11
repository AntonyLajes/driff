import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { verifySessionJwt } from "@/auth/session-jwt.js";
import type { Database } from "@/db/client.js";
import { jobsTable, workspacesTable } from "@/db/schema.js";
import { uniqueViolationConstraint } from "@/db/pg-error.js";
import {
  execute as createHistoryImportRepository,
  type HistoryImportRepository,
} from "@/history-imports/history-import-repository.js";
import { normalizeWorkspaceSlug } from "@/lib/workspace-slug.js";
import {
  canWriteWorkspaces,
  resolveTeamContext,
  type TeamRole,
} from "@/teams/team-context.js";
import { workspaceVisibilityCondition } from "@/workspaces/member-access.js";

const createBodySchema = z.object({
  periodMonths: z.number().int().min(1).max(24).optional().default(12),
  maxPullRequests: z.number().int().min(10).max(200).optional().default(100),
});

const importParamsSchema = z.object({
  slug: z.string(),
  importId: z.string().uuid().optional(),
});

type WorkspaceAccessResult =
  | { kind: "invalid_team" | "not_a_member" | "invalid_slug" | "not_found" }
  | {
      kind: "ok";
      workspace: {
        id: string;
        sourceProvider: string;
        repoFullName: string | null;
      };
      role: TeamRole;
    };

type ResolveWorkspace = NonNullable<
  HistoryImportsMeRegistrationInput["resolveWorkspace"]
>;

export interface HistoryImportsMeRegistrationInput {
  db: Database;
  jwtSecret: string;
  repository?: HistoryImportRepository;
  enqueue?: (input: {
    importId: string;
    workspaceId: string;
    repo: string;
  }) => Promise<void>;
  resolveWorkspace?: (input: {
    userId: string;
    requestedTeamId: string | undefined;
    slug: string;
  }) => Promise<WorkspaceAccessResult>;
}

const readBearerToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

const defaultWorkspaceResolver =
  (db: Database): ResolveWorkspace =>
  async ({ userId, requestedTeamId, slug }) => {
    const team = await resolveTeamContext(db, userId, requestedTeamId);
    if (team.kind !== "ok") {
      return { kind: team.kind };
    }
    const normalizedSlug = normalizeWorkspaceSlug(slug);
    if (
      normalizedSlug.length === 0 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)
    ) {
      return { kind: "invalid_slug" };
    }
    const rows = await db
      .select({
        id: workspacesTable.id,
        sourceProvider: workspacesTable.sourceProvider,
        repoFullName: workspacesTable.repoFullName,
      })
      .from(workspacesTable)
      .where(
        and(
          eq(workspacesTable.teamId, team.context.teamId),
          eq(workspacesTable.slug, normalizedSlug),
          workspaceVisibilityCondition({ userId, role: team.context.role }),
        ),
      )
      .limit(1);
    const workspace = rows[0];
    return workspace === undefined
      ? { kind: "not_found" }
      : { kind: "ok", workspace, role: team.context.role };
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

export const handler = async (
  instance: FastifyInstance,
  input: HistoryImportsMeRegistrationInput,
): Promise<void> => {
  const repository =
    input.repository ?? createHistoryImportRepository({ db: input.db });
  const resolveWorkspace: ResolveWorkspace =
    input.resolveWorkspace ?? defaultWorkspaceResolver(input.db);
  const enqueue =
    input.enqueue ??
    (async ({ importId, workspaceId, repo }) => {
      await input.db.insert(jobsTable).values({
        type: "import_history",
        payload: { importId, workspaceId, repo },
        status: "pending",
      });
    });

  const authorize = async (request: {
    headers: { authorization?: string; "x-team-id"?: string };
    params: unknown;
  }) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) return { kind: "unauthorized" as const };
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) return { kind: "invalid_session" as const };
    const params = importParamsSchema.safeParse(request.params);
    if (!params.success) return { kind: "invalid_params" as const };
    const access = await resolveWorkspace({
      userId: session.userId,
      requestedTeamId: request.headers["x-team-id"],
      slug: params.data.slug,
    });
    return { kind: "resolved" as const, session, params: params.data, access };
  };

  instance.get(
    "/api/me/workspaces/by-slug/:slug/history-imports/latest",
    async (request, reply) => {
      const auth = await authorize(request);
      if (auth.kind === "unauthorized") {
        return reply
          .status(401)
          .send({ error: "missing_or_invalid_authorization" });
      }
      if (auth.kind === "invalid_session") {
        return reply.status(401).send({ error: "invalid_session" });
      }
      if (auth.kind === "invalid_params") {
        return reply.status(400).send({ error: "invalid_params" });
      }
      if (auth.access.kind !== "ok") {
        return sendAccessError(auth.access, reply);
      }
      const historyImport = await repository.findLatestForWorkspace(
        auth.access.workspace.id,
      );
      return reply.send({ historyImport });
    },
  );

  instance.post(
    "/api/me/workspaces/by-slug/:slug/history-imports",
    async (request, reply) => {
      const auth = await authorize(request);
      if (auth.kind === "unauthorized") {
        return reply
          .status(401)
          .send({ error: "missing_or_invalid_authorization" });
      }
      if (auth.kind === "invalid_session") {
        return reply.status(401).send({ error: "invalid_session" });
      }
      if (auth.kind === "invalid_params") {
        return reply.status(400).send({ error: "invalid_params" });
      }
      if (auth.access.kind !== "ok") {
        return sendAccessError(auth.access, reply);
      }
      if (!canWriteWorkspaces(auth.access.role)) {
        return reply.status(403).send({ error: "insufficient_role" });
      }
      if (
        auth.access.workspace.sourceProvider !== "github" ||
        auth.access.workspace.repoFullName === null
      ) {
        return reply.status(400).send({ error: "github_repo_required" });
      }
      const body = createBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({ error: "invalid_body" });
      }
      try {
        const historyImport = await repository.create({
          workspaceId: auth.access.workspace.id,
          requestedByUserId: auth.session.userId,
          periodMonths: body.data.periodMonths,
          maxPullRequests: body.data.maxPullRequests,
        });
        try {
          await enqueue({
            importId: historyImport.id,
            workspaceId: historyImport.workspaceId,
            repo: auth.access.workspace.repoFullName,
          });
        } catch (error) {
          await repository.markFailed({
            id: historyImport.id,
            message:
              error instanceof Error
                ? error.message
                : "Failed to enqueue history import.",
            updatedAt: new Date(),
          });
          throw error;
        }
        return reply.status(202).send({ historyImport });
      } catch (error) {
        if (
          uniqueViolationConstraint(error) ===
          "history_imports_active_workspace_unique"
        ) {
          const historyImport = await repository.findLatestForWorkspace(
            auth.access.workspace.id,
          );
          return reply
            .status(409)
            .send({ error: "history_import_active", historyImport });
        }
        request.log.error({ err: error }, "history_import_enqueue_failed");
        return reply
          .status(500)
          .send({ error: "history_import_enqueue_failed" });
      }
    },
  );

  instance.delete(
    "/api/me/workspaces/by-slug/:slug/history-imports/:importId",
    async (request, reply) => {
      const auth = await authorize(request);
      if (auth.kind === "unauthorized") {
        return reply
          .status(401)
          .send({ error: "missing_or_invalid_authorization" });
      }
      if (auth.kind === "invalid_session") {
        return reply.status(401).send({ error: "invalid_session" });
      }
      if (auth.kind === "invalid_params") {
        return reply.status(400).send({ error: "invalid_params" });
      }
      if (auth.access.kind !== "ok") {
        return sendAccessError(auth.access, reply);
      }
      if (!canWriteWorkspaces(auth.access.role)) {
        return reply.status(403).send({ error: "insufficient_role" });
      }
      const cancelled = await repository.requestCancellation(
        auth.access.workspace.id,
        auth.params.importId ?? "",
        new Date(),
      );
      return cancelled
        ? reply.status(202).send({ cancelRequested: true })
        : reply.status(404).send({ error: "history_import_not_found" });
    },
  );
};
