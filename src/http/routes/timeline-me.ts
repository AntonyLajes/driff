import { Buffer } from "node:buffer";

import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { verifySessionJwt } from "@/auth/session-jwt.js";
import type { Database } from "@/db/client.js";
import { workspacesTable } from "@/db/schema.js";
import { normalizeWorkspaceSlug } from "@/lib/workspace-slug.js";
import {
  execute as readWorkspaceLineages,
  type ExecuteInput as ReadWorkspaceLineagesInput,
} from "@/lineages/read-workspace-lineages.js";
import { readTeamIdHeader, resolveTeamContext } from "@/teams/team-context.js";
import { workspaceVisibilityCondition } from "@/workspaces/member-access.js";
import {
  execute as readTimeline,
  type ExecuteInput as ReadTimelineInput,
} from "@/timeline/read-timeline.js";

const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional().default(10),
  cursor: z.string().min(1).max(1024).optional(),
});

const cursorPayloadSchema = z.object({
  releasedAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

const versionParamsSchema = z.object({
  slug: z.string(),
  versionId: z.string().uuid(),
});

const versionComparisonParamsSchema = z.object({
  slug: z.string(),
  baseVersionId: z.string().uuid(),
  targetVersionId: z.string().uuid(),
});

export interface TimelineMeRegistrationInput {
  db: Database;
  jwtSecret: string;
  timelineReader?: (
    input: ReadTimelineInput,
  ) => Promise<Awaited<ReturnType<typeof readTimeline>>>;
  lineageReader?: (
    input: ReadWorkspaceLineagesInput,
  ) => Promise<Awaited<ReturnType<typeof readWorkspaceLineages>>>;
}

const readBearerToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

const decodeCursor = (
  value: string | undefined,
): ReadTimelineInput["cursor"] | null => {
  if (value === undefined) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    const parsed = cursorPayloadSchema.safeParse(decoded);
    if (!parsed.success) return null;
    return {
      releasedAt: new Date(parsed.data.releasedAt),
      id: parsed.data.id,
    };
  } catch {
    return null;
  }
};

const encodeCursor = (cursor: { releasedAt: Date; id: string }): string =>
  Buffer.from(
    JSON.stringify({
      releasedAt: cursor.releasedAt.toISOString(),
      id: cursor.id,
    }),
    "utf8",
  ).toString("base64url");

export const handler = async (
  instance: FastifyInstance,
  input: TimelineMeRegistrationInput,
): Promise<void> => {
  instance.get(
    "/api/me/workspaces/by-slug/:slug/timeline",
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

      const queryParsed = timelineQuerySchema.safeParse(request.query);
      if (!queryParsed.success) {
        return reply.status(400).send({ error: "invalid_timeline_query" });
      }
      const cursor = decodeCursor(queryParsed.data.cursor);
      if (queryParsed.data.cursor !== undefined && cursor === null) {
        return reply.status(400).send({ error: "invalid_timeline_cursor" });
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
            workspaceVisibilityCondition({ userId: session.userId, role: team.context.role }),
          ),
        )
        .limit(1);
      const workspace = workspaceRows[0];
      if (workspace === undefined) {
        return reply.status(404).send({ error: "workspace_not_found" });
      }

      const result = await (input.timelineReader ?? readTimeline)({
        db: input.db,
        workspaceId: workspace.id,
        limit: queryParsed.data.limit,
        cursor,
      });

      return reply.send({
        workspace,
        versions: result.versions,
        inDevelopment: result.inDevelopment,
        pageInfo: {
          hasNextPage: result.pageInfo.hasNextPage,
          nextCursor:
            result.pageInfo.nextCursor === null
              ? null
              : encodeCursor(result.pageInfo.nextCursor),
        },
      });
    },
  );

  instance.get(
    "/api/me/workspaces/by-slug/:slug/lineages",
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
            workspaceVisibilityCondition({ userId: session.userId, role: team.context.role }),
          ),
        )
        .limit(1);
      const workspace = workspaceRows[0];
      if (workspace === undefined) {
        return reply.status(404).send({ error: "workspace_not_found" });
      }

      const result = await (input.lineageReader ?? readWorkspaceLineages)({
        db: input.db,
        workspaceId: workspace.id,
      });
      return reply.send({ workspace, lineages: result.lineages });
    },
  );

  instance.get(
    "/api/me/workspaces/by-slug/:slug/versions/:versionId",
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

      const paramsParsed = versionParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: "invalid_version_request" });
      }
      const slug = normalizeWorkspaceSlug(paramsParsed.data.slug);
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
            workspaceVisibilityCondition({ userId: session.userId, role: team.context.role }),
          ),
        )
        .limit(1);
      const workspace = workspaceRows[0];
      if (workspace === undefined) {
        return reply.status(404).send({ error: "workspace_not_found" });
      }

      const result = await (input.timelineReader ?? readTimeline)({
        db: input.db,
        workspaceId: workspace.id,
        versionId: paramsParsed.data.versionId,
        limit: 1,
        cursor: null,
      });
      const version = result.versions[0];
      if (version === undefined) {
        return reply.status(404).send({ error: "version_not_found" });
      }

      return reply.send({ workspace, version });
    },
  );

  instance.get(
    "/api/me/workspaces/by-slug/:slug/versions/:baseVersionId/compare/:targetVersionId",
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

      const paramsParsed = versionComparisonParamsSchema.safeParse(
        request.params,
      );
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: "invalid_version_comparison" });
      }
      if (
        paramsParsed.data.baseVersionId === paramsParsed.data.targetVersionId
      ) {
        return reply.status(400).send({ error: "versions_must_be_different" });
      }
      const slug = normalizeWorkspaceSlug(paramsParsed.data.slug);
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
            workspaceVisibilityCondition({ userId: session.userId, role: team.context.role }),
          ),
        )
        .limit(1);
      const workspace = workspaceRows[0];
      if (workspace === undefined) {
        return reply.status(404).send({ error: "workspace_not_found" });
      }

      const result = await (input.timelineReader ?? readTimeline)({
        db: input.db,
        workspaceId: workspace.id,
        versionIds: [
          paramsParsed.data.baseVersionId,
          paramsParsed.data.targetVersionId,
        ],
      });
      const baseVersion = result.versions.find(
        (version) => version.id === paramsParsed.data.baseVersionId,
      );
      const targetVersion = result.versions.find(
        (version) => version.id === paramsParsed.data.targetVersionId,
      );
      if (baseVersion === undefined || targetVersion === undefined) {
        return reply
          .status(404)
          .send({ error: "version_comparison_not_found" });
      }

      const baseChangeIds = new Set(
        baseVersion.changes.map((change) => change.id),
      );
      const targetChangeIds = new Set(
        targetVersion.changes.map((change) => change.id),
      );
      const activeLineage = (
        change: (typeof baseVersion.changes)[number],
      ) => {
        const active = (change.lineages ?? []).filter(
          (lineage) => lineage.status !== "merged",
        );
        return active.length === 1 ? (active[0] ?? null) : null;
      };
      const baseByLineage = new Map(
        baseVersion.changes.flatMap((change) => {
          const lineage = activeLineage(change);
          return lineage === null ? [] : [[lineage.id, change] as const];
        }),
      );
      const evolved = targetVersion.changes.flatMap((change) => {
        const lineage = activeLineage(change);
        if (lineage === null) return [];
        const previous = baseByLineage.get(lineage.id);
        if (previous === undefined || previous.id === change.id) return [];
        return [{ lineage, from: previous, to: change }];
      });
      const evolvedBaseIds = new Set(evolved.map((item) => item.from.id));
      const evolvedTargetIds = new Set(evolved.map((item) => item.to.id));

      return reply.send({
        workspace,
        baseVersion,
        targetVersion,
        comparison: {
          onlyInBase: baseVersion.changes.filter(
            (change) =>
              !targetChangeIds.has(change.id) &&
              !evolvedBaseIds.has(change.id),
          ),
          onlyInTarget: targetVersion.changes.filter(
            (change) =>
              !baseChangeIds.has(change.id) &&
              !evolvedTargetIds.has(change.id),
          ),
          shared: targetVersion.changes.filter((change) =>
            baseChangeIds.has(change.id),
          ),
          evolved,
          classification: evolved.length > 0 ? "lineage" : "snapshot",
        },
      });
    },
  );
};
