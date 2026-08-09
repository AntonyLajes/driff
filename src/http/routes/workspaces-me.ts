import type { FastifyInstance } from "fastify";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { Octokit } from "@octokit/rest";
import { and, count, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { verifySessionJwt } from "@/auth/session-jwt.js";
import { DEFAULT_HISTORY_EXCLUDED_PATHS } from "@/config/history-content-filter.js";
import {
  applyReleaseKindAndFilePath,
  isSupportedReleaseProjectKind,
  releaseProjectKindSchema,
} from "@/config/release-project-kind.js";
import type { Database } from "@/db/client.js";
import {
  changeEvidenceTable,
  jobsTable,
  changeAreasTable,
  productAreasTable,
  pullRequestsTable,
  pushesTable,
  releasesTable,
  summaryCorrectionsTable,
  usersTable,
  workspaceDestinationsTable,
  workspaceSettingsTable,
  workspacesTable,
} from "@/db/schema.js";
import { isUniqueViolation, uniqueViolationConstraint } from "@/db/pg-error.js";
import { loadUserGithubAccessToken } from "@/github/load-user-github-access-token.js";
import { reviewTimeSavedMinutes } from "@/lib/review-time.js";
import { normalizeWorkspaceSlug, slugifyWorkspaceName } from "@/lib/workspace-slug.js";
import { isImplementedProvider, sourceProviderSchema } from "@/sources/registry.js";
import {
  canWriteWorkspaces,
  readTeamIdHeader,
  resolveTeamContext,
} from "@/teams/team-context.js";
import { inferAndApplyWorkspaceSettings } from "@/workspaces/infer-workspace-settings.js";

export interface WorkspacesMeRegistrationInput {
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

const uniqueViolationTarget = uniqueViolationConstraint;

const workspaceIdParamSchema = z.string().uuid();

const repoFullNameSchema = z
  .string()
  .min(3)
  .max(241)
  .regex(/^[\w.-]+\/[\w.-]+$/u, "expected owner/repo");

const createWorkspaceBodySchema = z.object({
  sourceProvider: sourceProviderSchema.default("github"),
  repoFullName: repoFullNameSchema,
  repoDefaultBranch: z.string().min(1).max(255).optional(),
  name: z.string().min(1).max(200).optional(),
  workspaceKind: z.string().min(1).max(64).optional(),
});

/** Derives a workspace slug from a repo full name's `name` part (`owner/name` -> `name`). */
const slugFromRepoFullName = (repoFullName: string): string => {
  const namePart = repoFullName.includes("/")
    ? repoFullName.slice(repoFullName.indexOf("/") + 1)
    : repoFullName;
  return slugifyWorkspaceName(namePart);
};

/** Derives a display name from a repo full name's `name` part when none is provided. */
const nameFromRepoFullName = (repoFullName: string): string => {
  const namePart = repoFullName.includes("/")
    ? repoFullName.slice(repoFullName.indexOf("/") + 1)
    : repoFullName;
  return namePart.trim().length > 0 ? namePart.trim() : repoFullName;
};

const patchWorkspaceBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    workspaceKind: z.union([releaseProjectKindSchema, z.null()]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "empty_patch" });

const workspaceRowSelect = {
  id: workspacesTable.id,
  name: workspacesTable.name,
  slug: workspacesTable.slug,
  sourceProvider: workspacesTable.sourceProvider,
  workspaceKind: workspacesTable.workspaceKind,
  repoFullName: workspacesTable.repoFullName,
  repoDefaultBranch: workspacesTable.repoDefaultBranch,
  createdAt: workspacesTable.createdAt,
  updatedAt: workspacesTable.updatedAt,
};

const patchWorkspaceSettingsBodySchema = z
  .object({
    pushSummaryBranches: z.union([z.array(z.string().min(1).max(255)).max(50), z.null()]).optional(),
    prSummaryBaseBranches: z
      .union([z.array(z.string().min(1).max(255)).max(50), z.null()])
      .optional(),
    releaseProjectKind: z.union([releaseProjectKindSchema, z.null()]).optional(),
    releaseVersionFilePath: z.union([z.string().max(512), z.null()]).optional(),
    releaseVersionBranch: z.union([z.string().max(255), z.null()]).optional(),
    historyExcludedPaths: z
      .union([z.array(z.string().min(1).max(512)).max(100), z.null()])
      .optional(),
    historyExcludedActors: z
      .union([z.array(z.string().min(1).max(255)).max(100), z.null()])
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "empty_patch" })
  .superRefine((body, ctx) => {
    const k = body.releaseProjectKind;
    const p = body.releaseVersionFilePath;
    if (k === undefined && p === undefined) {
      return;
    }
    if (k === undefined || p === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "release_kind_and_path_together",
        path: ["releaseProjectKind"],
      });
      return;
    }
    const kNull = k === null;
    const pNull = p === null;
    if (kNull !== pNull) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "release_kind_path_mismatch",
        path: ["releaseProjectKind"],
      });
      return;
    }
    if (k !== null && p !== null) {
      if (!isSupportedReleaseProjectKind(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unsupported_release_kind",
          path: ["releaseProjectKind"],
        });
      }
      if (!p.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "empty_release_version_file_path",
          path: ["releaseVersionFilePath"],
        });
      }
    }
  });

const patchSummaryBodySchema = z
  .object({
    summaryUserFacing: z.string().trim().min(1).max(20_000),
    summaryTechnical: z.string().trim().max(20_000).nullable().optional(),
  })
  .strict();

const patchProductAreaBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const repoContentsQuerySchema = z.object({
  path: z.string().max(2048).optional().default(""),
  ref: z.string().min(1).max(255).optional(),
});

const inferWorkspaceSettingsBodySchema = z.object({
  apply: z.boolean().optional().default(true),
});

/**
 * Team-aware workspace lookup: resolves the acting team (x-team-id header,
 * defaulting to the user's personal team) and finds the slug WITHIN that team.
 */
const loadWorkspaceForMember = async (
  db: Database,
  userId: string,
  requestedTeamId: string | undefined,
  slugParam: string,
) => {
  const teamResult = await resolveTeamContext(db, userId, requestedTeamId);
  if (teamResult.kind === "invalid_team") {
    return { kind: "invalid_team" as const };
  }
  if (teamResult.kind === "not_a_member") {
    return { kind: "not_a_member" as const };
  }
  const team = teamResult.context;
  const slug = normalizeWorkspaceSlug(slugParam);
  if (slug.length === 0 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { kind: "invalid_slug" as const };
  }
  const rows = await db
    .select(workspaceRowSelect)
    .from(workspacesTable)
    .where(and(eq(workspacesTable.teamId, team.teamId), eq(workspacesTable.slug, slug)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { kind: "not_found" as const };
  }
  return { kind: "ok" as const, workspace: row, team };
};

type WorkspaceDiagnosticsIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
};

const buildWorkspaceDiagnostics = (input: {
  repoFullName: string | null;
  repoDefaultBranch: string | null;
  hasEnabledDestination: boolean;
  settings:
    | {
        pushSummaryBranches?: string[] | null;
        releaseProjectKind: string | null;
        releaseVersionFilePath: string | null;
        releaseVersionBranch: string | null;
      }
    | undefined;
}) => {
  const repo = input.repoFullName?.trim() ?? "";
  const defaultBranch = input.repoDefaultBranch?.trim() || "main";
  const settings = input.settings;
  const destinationConnected = input.hasEnabledDestination;

  const releaseKind = settings?.releaseProjectKind?.trim() ?? "";
  const releasePath = settings?.releaseVersionFilePath?.trim() ?? "";
  const releaseBranch = settings?.releaseVersionBranch?.trim() ?? "";
  const pushBranches = (settings?.pushSummaryBranches ?? [])
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const releaseSourceConfigured = releaseKind.length > 0 && releasePath.length > 0;

  const issues: WorkspaceDiagnosticsIssue[] = [];

  if (repo.length === 0) {
    issues.push({
      code: "workspace_repo_not_linked",
      severity: "error",
      message: "Link a repository to this workspace.",
    });
  }
  if (!destinationConnected) {
    issues.push({
      code: "destination_not_connected",
      severity: "error",
      message: "Connect an output destination (e.g. Notion) to publish summaries.",
    });
  }
  if (releaseSourceConfigured && !releaseBranch) {
    issues.push({
      code: "release_branch_missing",
      severity: "error",
      message: "Release version source is set but the release branch is missing.",
    });
  }
  if (!releaseSourceConfigured) {
    issues.push({
      code: "release_version_source_missing",
      severity: "warning",
      message: "Set a release version source (project kind + file) to enable version summaries.",
    });
  }

  const prSummaryReady = repo.length > 0 && destinationConnected;
  const releaseSummaryReady =
    prSummaryReady && releaseSourceConfigured && releaseBranch.length > 0;
  const pushSummaryReady = repo.length > 0 && destinationConnected && pushBranches.length > 0;

  return {
    repo: repo || null,
    defaultBranch,
    status: issues.some((i) => i.severity === "error")
      ? "error"
      : issues.length > 0
        ? "warning"
        : "ready",
    checks: {
      repoLinked: repo.length > 0,
      destinationConnected,
      prSummaryReady,
      releaseSummaryReady,
      pushSummaryReady,
    },
    suggested: {
      prBaseBranches: [defaultBranch],
      releaseBranch: defaultBranch,
      pushBranches: [defaultBranch],
    },
    issues,
  };
};

const hasEnabledDestination = async (db: Database, workspaceId: string): Promise<boolean> => {
  const rows = await db
    .select({ id: workspaceDestinationsTable.id })
    .from(workspaceDestinationsTable)
    .where(
      and(
        eq(workspaceDestinationsTable.workspaceId, workspaceId),
        eq(workspaceDestinationsTable.enabled, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

export const handler = async (
  instance: FastifyInstance,
  input: WorkspacesMeRegistrationInput,
): Promise<void> => {
  instance.get("/api/me/workspaces", async (request, reply) => {
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

    const rows = await input.db
      .select(workspaceRowSelect)
      .from(workspacesTable)
      .where(eq(workspacesTable.teamId, team.context.teamId))
      .orderBy(desc(workspacesTable.createdAt));

    return reply.send({ workspaces: [...rows] });
  });

  instance.get("/api/me/workspaces/by-slug/:slug/summary", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { slug?: string };
    const loaded = await loadWorkspaceForMember(
      input.db,
      session.userId,
      readTeamIdHeader(request.headers),
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (loaded.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const repo = loaded.workspace.repoFullName?.trim();
    if (repo === undefined || repo.length === 0) {
      return reply.send({ releases: [], pullRequests: [], pushes: [] });
    }

    const releaseRows = await input.db
      .select({
        id: releasesTable.id,
        shortVersion: releasesTable.shortVersion,
        buildVersion: releasesTable.buildVersion,
        branch: releasesTable.branch,
        headSha: releasesTable.headSha,
        createdAt: releasesTable.createdAt,
        changelog: releasesTable.changelog,
      })
      .from(releasesTable)
      .where(eq(releasesTable.repo, repo))
      .orderBy(desc(releasesTable.createdAt))
      .limit(15);

    const prRows = await input.db
      .select({
        id: pullRequestsTable.id,
        prNumber: pullRequestsTable.prNumber,
        title: pullRequestsTable.title,
        author: pullRequestsTable.author,
        mergedAt: pullRequestsTable.mergedAt,
        summaryUserFacing: pullRequestsTable.summaryUserFacing,
      })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.repo, repo))
      .orderBy(desc(pullRequestsTable.mergedAt))
      .limit(15);

    const pushRows = await input.db
      .select({
        id: pushesTable.id,
        title: pushesTable.title,
        branch: pushesTable.branch,
        pusher: pushesTable.pusher,
        pushedAt: pushesTable.pushedAt,
        commitCount: pushesTable.commitCount,
        category: pushesTable.category,
        compareUrl: pushesTable.compareUrl,
        summaryUserFacing: pushesTable.summaryUserFacing,
      })
      .from(pushesTable)
      .where(eq(pushesTable.repo, repo))
      .orderBy(desc(pushesTable.pushedAt))
      .limit(15);

    const maxChangelog = 480;
    const releases = releaseRows.map((r) => ({
      id: r.id,
      shortVersion: r.shortVersion,
      buildVersion: r.buildVersion,
      branch: r.branch,
      headSha: r.headSha,
      createdAt: r.createdAt,
      changelogPreview:
        r.changelog.length > maxChangelog ? `${r.changelog.slice(0, maxChangelog)}…` : r.changelog,
    }));

    return reply.send({ releases, pullRequests: prRows, pushes: pushRows });
  });

  const summaryTypes = ["pr", "push", "version"] as const;
  type SummaryType = (typeof summaryTypes)[number];
  const isSummaryType = (value: string): value is SummaryType =>
    (summaryTypes as readonly string[]).includes(value);
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const previewOf = (text: string | null, max = 280): string | null => {
    if (text === null) return null;
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  const wasDelivered = (pageId: string | null): boolean =>
    Boolean(pageId?.trim());
  const versionTitle = (shortVersion: string, buildVersion: string): string => {
    const build = buildVersion.trim();
    return build.length > 0
      ? `Version ${shortVersion} (${build})`
      : `Version ${shortVersion}`;
  };

  instance.get("/api/me/workspaces/by-slug/:slug/summaries", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const query = request.query as {
      type?: string;
      limit?: string;
      cursor?: string;
      q?: string;
    };
    const type = query.type ?? "all";
    if (type !== "all" && !isSummaryType(type)) {
      return reply.status(400).send({ error: "invalid_type" });
    }
    const limitRaw = Number(query.limit ?? "20");
    const limit = Number.isInteger(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 50)
      : 20;
    let cursor: Date | null = null;
    if (query.cursor !== undefined && query.cursor.length > 0) {
      const parsed = new Date(query.cursor);
      if (Number.isNaN(parsed.getTime())) {
        return reply.status(400).send({ error: "invalid_cursor" });
      }
      cursor = parsed;
    }
    const searchPattern =
      query.q !== undefined && query.q.trim().length > 0
        ? `%${query.q.trim()}%`
        : null;

    const params = request.params as { slug?: string };
    const loaded = await loadWorkspaceForMember(
      input.db,
      session.userId,
      readTeamIdHeader(request.headers),
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (loaded.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const repo = loaded.workspace.repoFullName?.trim();
    if (repo === undefined || repo.length === 0) {
      return reply.send({
        items: [],
        nextCursor: null,
        counts: { all: 0, pr: 0, push: 0, version: 0 },
      });
    }

    const wants = (t: SummaryType) => type === "all" || type === t;
    const fetchLimit = limit + 1;

    interface FeedItem {
      id: string;
      type: SummaryType;
      title: string;
      timestamp: Date;
      author: string | null;
      branch: string | null;
      summaryPreview: string | null;
      additions: number | null;
      deletions: number | null;
      changedFiles: number | null;
      prNumber: number | null;
      commitCount: number | null;
      shortVersion: string | null;
      delivered: boolean;
    }
    const items: FeedItem[] = [];

    if (wants("pr")) {
      const conditions = [eq(pullRequestsTable.repo, repo)];
      if (cursor !== null) {
        conditions.push(lt(pullRequestsTable.mergedAt, cursor));
      }
      if (searchPattern !== null) {
        const match = or(
          ilike(pullRequestsTable.title, searchPattern),
          ilike(pullRequestsTable.summaryUserFacing, searchPattern),
        );
        if (match !== undefined) {
          conditions.push(match);
        }
      }
      const rows = await input.db
        .select({
          id: pullRequestsTable.id,
          prNumber: pullRequestsTable.prNumber,
          title: pullRequestsTable.title,
          author: pullRequestsTable.author,
          baseBranch: pullRequestsTable.baseBranch,
          mergedAt: pullRequestsTable.mergedAt,
          summaryUserFacing: pullRequestsTable.summaryUserFacing,
          additions: pullRequestsTable.additions,
          deletions: pullRequestsTable.deletions,
          changedFiles: pullRequestsTable.changedFiles,
          notionPageId: pullRequestsTable.notionPageId,
        })
        .from(pullRequestsTable)
        .where(and(...conditions))
        .orderBy(desc(pullRequestsTable.mergedAt))
        .limit(fetchLimit);
      for (const r of rows) {
        items.push({
          id: r.id,
          type: "pr",
          title: r.title,
          timestamp: r.mergedAt,
          author: r.author,
          branch: r.baseBranch,
          summaryPreview: previewOf(r.summaryUserFacing),
          additions: r.additions,
          deletions: r.deletions,
          changedFiles: r.changedFiles,
          prNumber: r.prNumber,
          commitCount: null,
          shortVersion: null,
          delivered: wasDelivered(r.notionPageId),
        });
      }
    }

    if (wants("push")) {
      const conditions = [eq(pushesTable.repo, repo)];
      if (cursor !== null) {
        conditions.push(lt(pushesTable.pushedAt, cursor));
      }
      if (searchPattern !== null) {
        const match = or(
          ilike(pushesTable.title, searchPattern),
          ilike(pushesTable.summaryUserFacing, searchPattern),
        );
        if (match !== undefined) {
          conditions.push(match);
        }
      }
      const rows = await input.db
        .select({
          id: pushesTable.id,
          title: pushesTable.title,
          branch: pushesTable.branch,
          pusher: pushesTable.pusher,
          pushedAt: pushesTable.pushedAt,
          commitCount: pushesTable.commitCount,
          summaryUserFacing: pushesTable.summaryUserFacing,
          additions: pushesTable.additions,
          deletions: pushesTable.deletions,
          changedFiles: pushesTable.changedFiles,
          notionPageId: pushesTable.notionPageId,
        })
        .from(pushesTable)
        .where(and(...conditions))
        .orderBy(desc(pushesTable.pushedAt))
        .limit(fetchLimit);
      for (const r of rows) {
        items.push({
          id: r.id,
          type: "push",
          title: r.title,
          timestamp: r.pushedAt,
          author: r.pusher,
          branch: r.branch,
          summaryPreview: previewOf(r.summaryUserFacing),
          additions: r.additions,
          deletions: r.deletions,
          changedFiles: r.changedFiles,
          prNumber: null,
          commitCount: r.commitCount,
          shortVersion: null,
          delivered: wasDelivered(r.notionPageId),
        });
      }
    }

    if (wants("version")) {
      const conditions = [eq(releasesTable.repo, repo)];
      if (cursor !== null) {
        conditions.push(lt(releasesTable.createdAt, cursor));
      }
      if (searchPattern !== null) {
        const match = or(
          ilike(releasesTable.shortVersion, searchPattern),
          ilike(releasesTable.changelog, searchPattern),
        );
        if (match !== undefined) {
          conditions.push(match);
        }
      }
      const rows = await input.db
        .select({
          id: releasesTable.id,
          shortVersion: releasesTable.shortVersion,
          buildVersion: releasesTable.buildVersion,
          branch: releasesTable.branch,
          createdAt: releasesTable.createdAt,
          changelog: releasesTable.changelog,
          notionPageId: releasesTable.notionPageId,
        })
        .from(releasesTable)
        .where(and(...conditions))
        .orderBy(desc(releasesTable.createdAt))
        .limit(fetchLimit);
      for (const r of rows) {
        items.push({
          id: r.id,
          type: "version",
          title: versionTitle(r.shortVersion, r.buildVersion),
          timestamp: r.createdAt,
          author: null,
          branch: r.branch,
          summaryPreview: previewOf(r.changelog),
          additions: null,
          deletions: null,
          changedFiles: null,
          prNumber: null,
          commitCount: null,
          shortVersion: r.shortVersion,
          delivered: wasDelivered(r.notionPageId),
        });
      }
    }

    items.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const page = items.slice(0, limit);
    const lastItem = page[page.length - 1];
    const nextCursor =
      items.length > limit && lastItem !== undefined
        ? lastItem.timestamp.toISOString()
        : null;

    // Counts always reflect repo-wide totals per type (independent of type/q/cursor).
    const [prCount] = await input.db
      .select({ value: count() })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.repo, repo));
    const [pushCount] = await input.db
      .select({ value: count() })
      .from(pushesTable)
      .where(eq(pushesTable.repo, repo));
    const [versionCount] = await input.db
      .select({ value: count() })
      .from(releasesTable)
      .where(eq(releasesTable.repo, repo));
    const counts = {
      pr: prCount?.value ?? 0,
      push: pushCount?.value ?? 0,
      version: versionCount?.value ?? 0,
    };

    return reply.send({
      items: page.map((item) => ({
        ...item,
        timestamp: item.timestamp.toISOString(),
      })),
      nextCursor,
      counts: { all: counts.pr + counts.push + counts.version, ...counts },
    });
  });

  instance.get(
    "/api/me/workspaces/by-slug/:slug/summaries/:type/:id",
    async (request, reply) => {
      const token = readBearerToken(request.headers.authorization);
      if (token === null) {
        return reply.status(401).send({ error: "missing_or_invalid_authorization" });
      }
      const session = verifySessionJwt(token, input.jwtSecret);
      if (session === null) {
        return reply.status(401).send({ error: "invalid_session" });
      }

      const params = request.params as { slug?: string; type?: string; id?: string };
      const type = params.type ?? "";
      if (!isSummaryType(type)) {
        return reply.status(400).send({ error: "invalid_type" });
      }
      const id = params.id ?? "";
      if (!uuidPattern.test(id)) {
        return reply.status(400).send({ error: "invalid_id" });
      }

      const loaded = await loadWorkspaceForMember(
        input.db,
        session.userId,
        readTeamIdHeader(request.headers),
        params.slug ?? "",
      );
      if (loaded.kind === "invalid_team") {
        return reply.status(400).send({ error: "invalid_team" });
      }
      if (loaded.kind === "not_a_member") {
        return reply.status(403).send({ error: "not_a_team_member" });
      }
      if (loaded.kind === "invalid_slug") {
        return reply.status(400).send({ error: "invalid_slug" });
      }
      if (loaded.kind === "not_found") {
        return reply.status(404).send({ error: "workspace_not_found" });
      }

      const repo = loaded.workspace.repoFullName?.trim();
      if (repo === undefined || repo.length === 0) {
        return reply.status(404).send({ error: "summary_not_found" });
      }

      /* Type-specific extras default to null so the response keeps one flat shape. */
      const base = {
        prNumber: null as number | null,
        commitCount: null as number | null,
        compareUrl: null as string | null,
        headSha: null as string | null,
        shortVersion: null as string | null,
        buildVersion: null as string | null,
        prNumbers: null as number[] | null,
        sections: null as Record<string, unknown> | null,
      };
      const loadEvidence = async (sourceRecordType: string) =>
        input.db
          .select({
            id: changeEvidenceTable.id,
            kind: changeEvidenceTable.kind,
            externalId: changeEvidenceTable.externalId,
            url: changeEvidenceTable.url,
            sha: changeEvidenceTable.sha,
            path: changeEvidenceTable.path,
            occurredAt: changeEvidenceTable.occurredAt,
          })
          .from(changeEvidenceTable)
          .where(
            and(
              eq(changeEvidenceTable.sourceRecordType, sourceRecordType),
              eq(changeEvidenceTable.sourceRecordId, id),
            ),
          )
          .orderBy(desc(changeEvidenceTable.occurredAt), desc(changeEvidenceTable.id));
      const loadLatestCorrection = async (sourceRecordType: string) => {
        const rows = await input.db
          .select({
            correctedAt: summaryCorrectionsTable.createdAt,
            correctedByUserId: summaryCorrectionsTable.editedByUserId,
            correctedByName: usersTable.name,
            correctedByEmail: usersTable.email,
          })
          .from(summaryCorrectionsTable)
          .innerJoin(usersTable, eq(usersTable.id, summaryCorrectionsTable.editedByUserId))
          .where(
            and(
              eq(summaryCorrectionsTable.sourceRecordType, sourceRecordType),
              eq(summaryCorrectionsTable.sourceRecordId, id),
            ),
          )
          .orderBy(desc(summaryCorrectionsTable.createdAt))
          .limit(1);
        const correction = rows[0];
        return correction === undefined
          ? null
          : {
              correctedAt: correction.correctedAt.toISOString(),
              correctedBy: {
                id: correction.correctedByUserId,
                name: correction.correctedByName,
                email: correction.correctedByEmail,
              },
            };
      };

      if (type === "pr") {
        const rows = await input.db
          .select({
            id: pullRequestsTable.id,
            prNumber: pullRequestsTable.prNumber,
            title: pullRequestsTable.title,
            author: pullRequestsTable.author,
            baseBranch: pullRequestsTable.baseBranch,
            mergedAt: pullRequestsTable.mergedAt,
            headSha: pullRequestsTable.headSha,
            summaryUserFacing: pullRequestsTable.summaryUserFacing,
            summaryTechnical: pullRequestsTable.summaryTechnical,
            category: pullRequestsTable.category,
            area: pullRequestsTable.area,
            additions: pullRequestsTable.additions,
            deletions: pullRequestsTable.deletions,
            changedFiles: pullRequestsTable.changedFiles,
            notionPageId: pullRequestsTable.notionPageId,
          })
          .from(pullRequestsTable)
          .where(and(eq(pullRequestsTable.id, id), eq(pullRequestsTable.repo, repo)))
          .limit(1);
        const r = rows[0];
        if (r === undefined) {
          return reply.status(404).send({ error: "summary_not_found" });
        }
        const [evidence, correction] = await Promise.all([
          loadEvidence("pull_requests"),
          loadLatestCorrection("pull_requests"),
        ]);
        return reply.send({
          summary: {
            ...base,
            id: r.id,
            type: "pr",
            title: r.title,
            timestamp: r.mergedAt.toISOString(),
            author: r.author,
            branch: r.baseBranch,
            summaryUserFacing: r.summaryUserFacing,
            summaryTechnical: r.summaryTechnical,
            category: r.category,
            area: r.area,
            additions: r.additions,
            deletions: r.deletions,
            changedFiles: r.changedFiles,
            delivered: wasDelivered(r.notionPageId),
            prNumber: r.prNumber,
            headSha: r.headSha,
            evidence: evidence.map((item) => ({
              ...item,
              occurredAt: item.occurredAt.toISOString(),
            })),
            correction,
          },
        });
      }

      if (type === "push") {
        const rows = await input.db
          .select({
            id: pushesTable.id,
            title: pushesTable.title,
            branch: pushesTable.branch,
            pusher: pushesTable.pusher,
            pushedAt: pushesTable.pushedAt,
            commitCount: pushesTable.commitCount,
            compareUrl: pushesTable.compareUrl,
            prNumbers: pushesTable.prNumbers,
            summaryUserFacing: pushesTable.summaryUserFacing,
            summaryTechnical: pushesTable.summaryTechnical,
            category: pushesTable.category,
            area: pushesTable.area,
            additions: pushesTable.additions,
            deletions: pushesTable.deletions,
            changedFiles: pushesTable.changedFiles,
            notionPageId: pushesTable.notionPageId,
          })
          .from(pushesTable)
          .where(and(eq(pushesTable.id, id), eq(pushesTable.repo, repo)))
          .limit(1);
        const r = rows[0];
        if (r === undefined) {
          return reply.status(404).send({ error: "summary_not_found" });
        }
        const [evidence, correction] = await Promise.all([
          loadEvidence("pushes"),
          loadLatestCorrection("pushes"),
        ]);
        return reply.send({
          summary: {
            ...base,
            id: r.id,
            type: "push",
            title: r.title,
            timestamp: r.pushedAt.toISOString(),
            author: r.pusher,
            branch: r.branch,
            summaryUserFacing: r.summaryUserFacing,
            summaryTechnical: r.summaryTechnical,
            category: r.category,
            area: r.area,
            additions: r.additions,
            deletions: r.deletions,
            changedFiles: r.changedFiles,
            delivered: wasDelivered(r.notionPageId),
            commitCount: r.commitCount,
            compareUrl: r.compareUrl,
            prNumbers: r.prNumbers,
            evidence: evidence.map((item) => ({
              ...item,
              occurredAt: item.occurredAt.toISOString(),
            })),
            correction,
          },
        });
      }

      const rows = await input.db
        .select({
          id: releasesTable.id,
          shortVersion: releasesTable.shortVersion,
          buildVersion: releasesTable.buildVersion,
          branch: releasesTable.branch,
          headSha: releasesTable.headSha,
          createdAt: releasesTable.createdAt,
          prNumbers: releasesTable.prNumbers,
          changelog: releasesTable.changelog,
          sections: releasesTable.sections,
          notionPageId: releasesTable.notionPageId,
        })
        .from(releasesTable)
        .where(and(eq(releasesTable.id, id), eq(releasesTable.repo, repo)))
        .limit(1);
      const r = rows[0];
      if (r === undefined) {
        return reply.status(404).send({ error: "summary_not_found" });
      }
      const [evidence, correction] = await Promise.all([
        loadEvidence("releases"),
        loadLatestCorrection("releases"),
      ]);
      return reply.send({
        summary: {
          ...base,
          id: r.id,
          type: "version",
          title: versionTitle(r.shortVersion, r.buildVersion),
          timestamp: r.createdAt.toISOString(),
          author: null,
          branch: r.branch,
          summaryUserFacing: r.changelog,
          summaryTechnical: null,
          category: null,
          area: null,
          additions: null,
          deletions: null,
          changedFiles: null,
          delivered: wasDelivered(r.notionPageId),
          shortVersion: r.shortVersion,
          buildVersion: r.buildVersion.trim() || null,
          headSha: r.headSha,
          prNumbers: r.prNumbers,
          sections: r.sections ?? null,
          evidence: evidence.map((item) => ({
            ...item,
            occurredAt: item.occurredAt.toISOString(),
          })),
          correction,
        },
      });
    },
  );

  instance.patch(
    "/api/me/workspaces/by-slug/:slug/summaries/:type/:id",
    async (request, reply) => {
      const token = readBearerToken(request.headers.authorization);
      if (token === null) {
        return reply.status(401).send({ error: "missing_or_invalid_authorization" });
      }
      const session = verifySessionJwt(token, input.jwtSecret);
      if (session === null) {
        return reply.status(401).send({ error: "invalid_session" });
      }

      const params = request.params as { slug?: string; type?: string; id?: string };
      const type = params.type ?? "";
      const id = params.id ?? "";
      if (!isSummaryType(type) || !uuidPattern.test(id)) {
        return reply.status(400).send({ error: "invalid_summary_reference" });
      }
      const parsedBody = patchSummaryBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({ error: "invalid_body" });
      }

      const loaded = await loadWorkspaceForMember(
        input.db,
        session.userId,
        readTeamIdHeader(request.headers),
        params.slug ?? "",
      );
      if (loaded.kind === "invalid_team") {
        return reply.status(400).send({ error: "invalid_team" });
      }
      if (loaded.kind === "not_a_member") {
        return reply.status(403).send({ error: "not_a_team_member" });
      }
      if (loaded.kind === "invalid_slug") {
        return reply.status(400).send({ error: "invalid_slug" });
      }
      if (loaded.kind === "not_found") {
        return reply.status(404).send({ error: "workspace_not_found" });
      }
      if (!canWriteWorkspaces(loaded.team.role)) {
        return reply.status(403).send({ error: "insufficient_role" });
      }
      const repo = loaded.workspace.repoFullName?.trim();
      if (!repo) {
        return reply.status(404).send({ error: "summary_not_found" });
      }

      const now = new Date();
      const body = parsedBody.data;
      let beforeUserFacing: string | null;
      let beforeTechnical: string | null;
      let sourceRecordType: string;
      let updated: Array<{ id: string }>;
      if (type === "pr") {
        const current = await input.db
          .select({
            summaryUserFacing: pullRequestsTable.summaryUserFacing,
            summaryTechnical: pullRequestsTable.summaryTechnical,
          })
          .from(pullRequestsTable)
          .where(and(eq(pullRequestsTable.id, id), eq(pullRequestsTable.repo, repo)))
          .limit(1);
        if (current[0] === undefined) {
          return reply.status(404).send({ error: "summary_not_found" });
        }
        beforeUserFacing = current[0].summaryUserFacing;
        beforeTechnical = current[0].summaryTechnical;
        sourceRecordType = "pull_requests";
        updated = await input.db
          .update(pullRequestsTable)
          .set({
            summaryUserFacing: body.summaryUserFacing,
            summaryTechnical: body.summaryTechnical,
            updatedAt: now,
          })
          .where(and(eq(pullRequestsTable.id, id), eq(pullRequestsTable.repo, repo)))
          .returning({ id: pullRequestsTable.id });
      } else if (type === "push") {
        const current = await input.db
          .select({
            summaryUserFacing: pushesTable.summaryUserFacing,
            summaryTechnical: pushesTable.summaryTechnical,
          })
          .from(pushesTable)
          .where(and(eq(pushesTable.id, id), eq(pushesTable.repo, repo)))
          .limit(1);
        if (current[0] === undefined) {
          return reply.status(404).send({ error: "summary_not_found" });
        }
        beforeUserFacing = current[0].summaryUserFacing;
        beforeTechnical = current[0].summaryTechnical;
        sourceRecordType = "pushes";
        updated = await input.db
          .update(pushesTable)
          .set({
            summaryUserFacing: body.summaryUserFacing,
            summaryTechnical: body.summaryTechnical,
            updatedAt: now,
          })
          .where(and(eq(pushesTable.id, id), eq(pushesTable.repo, repo)))
          .returning({ id: pushesTable.id });
      } else {
        const current = await input.db
          .select({ changelog: releasesTable.changelog })
          .from(releasesTable)
          .where(and(eq(releasesTable.id, id), eq(releasesTable.repo, repo)))
          .limit(1);
        if (current[0] === undefined) {
          return reply.status(404).send({ error: "summary_not_found" });
        }
        beforeUserFacing = current[0].changelog;
        beforeTechnical = null;
        sourceRecordType = "releases";
        updated = await input.db
          .update(releasesTable)
          .set({ changelog: body.summaryUserFacing, updatedAt: now })
          .where(and(eq(releasesTable.id, id), eq(releasesTable.repo, repo)))
          .returning({ id: releasesTable.id });
      }

      if (updated.length === 0) {
        return reply.status(404).send({ error: "summary_not_found" });
      }
      await input.db.insert(summaryCorrectionsTable).values({
        workspaceId: loaded.workspace.id,
        sourceRecordType,
        sourceRecordId: id,
        editedByUserId: session.userId,
        beforeUserFacing,
        beforeTechnical,
        afterUserFacing: body.summaryUserFacing,
        afterTechnical: type === "version" ? null : (body.summaryTechnical ?? null),
        createdAt: now,
      });
      return reply.send({ updated: true, updatedAt: now.toISOString() });
    },
  );

  instance.post(
    "/api/me/workspaces/by-slug/:slug/summaries/:type/:id/regenerate",
    async (request, reply) => {
      const token = readBearerToken(request.headers.authorization);
      if (token === null) {
        return reply.status(401).send({ error: "missing_or_invalid_authorization" });
      }
      const session = verifySessionJwt(token, input.jwtSecret);
      if (session === null) {
        return reply.status(401).send({ error: "invalid_session" });
      }

      const params = request.params as { slug?: string; type?: string; id?: string };
      const type = params.type ?? "";
      const id = params.id ?? "";
      if (!isSummaryType(type) || !uuidPattern.test(id)) {
        return reply.status(400).send({ error: "invalid_summary_reference" });
      }

      const loaded = await loadWorkspaceForMember(
        input.db,
        session.userId,
        readTeamIdHeader(request.headers),
        params.slug ?? "",
      );
      if (loaded.kind === "invalid_team") {
        return reply.status(400).send({ error: "invalid_team" });
      }
      if (loaded.kind === "not_a_member") {
        return reply.status(403).send({ error: "not_a_team_member" });
      }
      if (loaded.kind === "invalid_slug") {
        return reply.status(400).send({ error: "invalid_slug" });
      }
      if (loaded.kind === "not_found") {
        return reply.status(404).send({ error: "workspace_not_found" });
      }
      if (!canWriteWorkspaces(loaded.team.role)) {
        return reply.status(403).send({ error: "insufficient_role" });
      }

      const repo = loaded.workspace.repoFullName?.trim();
      if (repo === undefined || repo.length === 0) {
        return reply.status(404).send({ error: "summary_not_found" });
      }

      let jobType: "process_pr" | "process_push" | "process_release";
      let payload: Record<string, unknown>;
      if (type === "pr") {
        const rows = await input.db
          .select({ prNumber: pullRequestsTable.prNumber })
          .from(pullRequestsTable)
          .where(and(eq(pullRequestsTable.id, id), eq(pullRequestsTable.repo, repo)))
          .limit(1);
        if (rows[0] === undefined) {
          return reply.status(404).send({ error: "summary_not_found" });
        }
        jobType = "process_pr";
        payload = { repo, prNumber: rows[0].prNumber, force: true };
      } else if (type === "push") {
        const rows = await input.db
          .select({
            beforeSha: pushesTable.beforeSha,
            afterSha: pushesTable.afterSha,
            branch: pushesTable.branch,
            pusher: pushesTable.pusher,
            pushedAt: pushesTable.pushedAt,
          })
          .from(pushesTable)
          .where(and(eq(pushesTable.id, id), eq(pushesTable.repo, repo)))
          .limit(1);
        if (rows[0] === undefined) {
          return reply.status(404).send({ error: "summary_not_found" });
        }
        jobType = "process_push";
        payload = {
          repo,
          beforeSha: rows[0].beforeSha,
          afterSha: rows[0].afterSha,
          branch: rows[0].branch,
          pusher: rows[0].pusher,
          pushedAt: rows[0].pushedAt.toISOString(),
          force: true,
        };
      } else {
        const rows = await input.db
          .select({
            beforeSha: releasesTable.beforeSha,
            afterSha: releasesTable.headSha,
            branch: releasesTable.branch,
            releasedAt: releasesTable.createdAt,
          })
          .from(releasesTable)
          .where(and(eq(releasesTable.id, id), eq(releasesTable.repo, repo)))
          .limit(1);
        if (rows[0] === undefined) {
          return reply.status(404).send({ error: "summary_not_found" });
        }
        jobType = "process_release";
        payload = {
          repo,
          beforeSha: rows[0].beforeSha,
          afterSha: rows[0].afterSha,
          branch: rows[0].branch,
          releasedAt: rows[0].releasedAt.toISOString(),
          force: true,
        };
      }

      const now = new Date();
      await input.db.insert(jobsTable).values({
        type: jobType,
        payload,
        status: "pending",
        attempts: 0,
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return reply.status(202).send({ queued: true, type });
    },
  );

  instance.get("/api/me/workspaces/by-slug/:slug/stats", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { slug?: string };
    const loaded = await loadWorkspaceForMember(
      input.db,
      session.userId,
      readTeamIdHeader(request.headers),
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (loaded.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const zeroStats = {
      summaries: 0,
      prs: 0,
      pushes: 0,
      versions: 0,
      reviewTimeSavedMinutes: 0,
      weekDeltas: {
        summaries: 0,
        prs: 0,
        pushes: 0,
        versions: 0,
        reviewTimeSavedMinutes: 0,
      },
    };
    const repo = loaded.workspace.repoFullName?.trim();
    if (repo === undefined || repo.length === 0) {
      return reply.send({ stats: zeroStats });
    }

    // postgres.js can't bind a Date inside a raw sql fragment — pass ISO text.
    const weekAgoIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const weekFilter = (column: AnyPgColumn) =>
      sql<number>`count(*) filter (where ${column} >= ${weekAgoIso})`.mapWith(Number);

    // Query order matters for the test mocks: pr → push → version.
    const [prAggregate] = await input.db
      .select({ total: count(), week: weekFilter(pullRequestsTable.mergedAt) })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.repo, repo));
    const [pushAggregate] = await input.db
      .select({ total: count(), week: weekFilter(pushesTable.pushedAt) })
      .from(pushesTable)
      .where(eq(pushesTable.repo, repo));
    const [versionAggregate] = await input.db
      .select({ total: count(), week: weekFilter(releasesTable.createdAt) })
      .from(releasesTable)
      .where(eq(releasesTable.repo, repo));

    const prs = prAggregate?.total ?? 0;
    const pushes = pushAggregate?.total ?? 0;
    const versions = versionAggregate?.total ?? 0;
    const weekPrs = prAggregate?.week ?? 0;
    const weekPushes = pushAggregate?.week ?? 0;
    const weekVersions = versionAggregate?.week ?? 0;

    return reply.send({
      stats: {
        summaries: prs + pushes + versions,
        prs,
        pushes,
        versions,
        reviewTimeSavedMinutes: reviewTimeSavedMinutes(prs, pushes),
        weekDeltas: {
          summaries: weekPrs + weekPushes + weekVersions,
          prs: weekPrs,
          pushes: weekPushes,
          versions: weekVersions,
          reviewTimeSavedMinutes: reviewTimeSavedMinutes(weekPrs, weekPushes),
        },
      },
    });
  });

  instance.get("/api/me/workspaces/by-slug/:slug/settings", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { slug?: string };
    const loaded = await loadWorkspaceForMember(
      input.db,
      session.userId,
      readTeamIdHeader(request.headers),
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (loaded.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const wsId = loaded.workspace.id;
    const rows = await input.db
      .select({
        pushSummaryBranches: workspaceSettingsTable.pushSummaryBranches,
        prSummaryBaseBranches: workspaceSettingsTable.prSummaryBaseBranches,
        releaseProjectKind: workspaceSettingsTable.releaseProjectKind,
        releaseVersionFilePath: workspaceSettingsTable.releaseVersionFilePath,
        releaseVersionBranch: workspaceSettingsTable.releaseVersionBranch,
        historyExcludedPaths: workspaceSettingsTable.historyExcludedPaths,
        historyExcludedActors: workspaceSettingsTable.historyExcludedActors,
      })
      .from(workspaceSettingsTable)
      .where(eq(workspaceSettingsTable.workspaceId, wsId))
      .limit(1);
    const row = rows[0];
    return reply.send({
      settings: {
        pushSummaryBranches: row?.pushSummaryBranches ?? null,
        prSummaryBaseBranches: row?.prSummaryBaseBranches ?? null,
        releaseProjectKind: row?.releaseProjectKind ?? null,
        releaseVersionFilePath: row?.releaseVersionFilePath ?? null,
        releaseVersionBranch: row?.releaseVersionBranch ?? null,
        historyExcludedPaths:
          row?.historyExcludedPaths ?? [...DEFAULT_HISTORY_EXCLUDED_PATHS],
        historyExcludedActors: row?.historyExcludedActors ?? [],
      },
    });
  });

  instance.get(
    "/api/me/workspaces/by-slug/:slug/product-areas",
    async (request, reply) => {
      const token = readBearerToken(request.headers.authorization);
      if (token === null) {
        return reply.status(401).send({ error: "missing_or_invalid_authorization" });
      }
      const session = verifySessionJwt(token, input.jwtSecret);
      if (session === null) {
        return reply.status(401).send({ error: "invalid_session" });
      }

      const params = request.params as { slug?: string };
      const loaded = await loadWorkspaceForMember(
        input.db,
        session.userId,
        readTeamIdHeader(request.headers),
        params.slug ?? "",
      );
      if (loaded.kind === "invalid_team") {
        return reply.status(400).send({ error: "invalid_team" });
      }
      if (loaded.kind === "not_a_member") {
        return reply.status(403).send({ error: "not_a_team_member" });
      }
      if (loaded.kind === "invalid_slug") {
        return reply.status(400).send({ error: "invalid_slug" });
      }
      if (loaded.kind === "not_found") {
        return reply.status(404).send({ error: "workspace_not_found" });
      }

      const areas = await input.db
        .select({
          id: productAreasTable.id,
          name: productAreasTable.name,
          slug: productAreasTable.slug,
          rules: productAreasTable.rules,
          updatedAt: productAreasTable.updatedAt,
          changeCount: count(changeAreasTable.changeId).mapWith(Number),
        })
        .from(productAreasTable)
        .innerJoin(changeAreasTable, eq(changeAreasTable.areaId, productAreasTable.id))
        .where(eq(productAreasTable.workspaceId, loaded.workspace.id))
        .groupBy(
          productAreasTable.id,
          productAreasTable.name,
          productAreasTable.slug,
          productAreasTable.rules,
          productAreasTable.updatedAt,
        )
        .orderBy(productAreasTable.name);

      return reply.send({ areas });
    },
  );

  instance.patch(
    "/api/me/workspaces/by-slug/:slug/product-areas/:areaId",
    async (request, reply) => {
      const token = readBearerToken(request.headers.authorization);
      if (token === null) {
        return reply.status(401).send({ error: "missing_or_invalid_authorization" });
      }
      const session = verifySessionJwt(token, input.jwtSecret);
      if (session === null) {
        return reply.status(401).send({ error: "invalid_session" });
      }

      const params = request.params as { slug?: string; areaId?: string };
      const loaded = await loadWorkspaceForMember(
        input.db,
        session.userId,
        readTeamIdHeader(request.headers),
        params.slug ?? "",
      );
      if (loaded.kind === "invalid_team") {
        return reply.status(400).send({ error: "invalid_team" });
      }
      if (loaded.kind === "not_a_member") {
        return reply.status(403).send({ error: "not_a_team_member" });
      }
      if (loaded.kind === "invalid_slug") {
        return reply.status(400).send({ error: "invalid_slug" });
      }
      if (loaded.kind === "not_found") {
        return reply.status(404).send({ error: "workspace_not_found" });
      }
      if (!canWriteWorkspaces(loaded.team.role)) {
        return reply.status(403).send({ error: "insufficient_role" });
      }

      const parsedAreaId = workspaceIdParamSchema.safeParse(params.areaId);
      const parsedBody = patchProductAreaBodySchema.safeParse(request.body);
      if (!parsedAreaId.success || !parsedBody.success) {
        return reply.status(400).send({ error: "invalid_body" });
      }

      const rows = await input.db
        .update(productAreasTable)
        .set({ name: parsedBody.data.name, updatedAt: new Date() })
        .where(
          and(
            eq(productAreasTable.id, parsedAreaId.data),
            eq(productAreasTable.workspaceId, loaded.workspace.id),
          ),
        )
        .returning({
          id: productAreasTable.id,
          name: productAreasTable.name,
          slug: productAreasTable.slug,
          rules: productAreasTable.rules,
          updatedAt: productAreasTable.updatedAt,
        });
      const area = rows[0];
      if (area === undefined) {
        return reply.status(404).send({ error: "product_area_not_found" });
      }

      return reply.send({ area });
    },
  );

  instance.get("/api/me/workspaces/by-slug/:slug/diagnostics", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { slug?: string };
    const loaded = await loadWorkspaceForMember(
      input.db,
      session.userId,
      readTeamIdHeader(request.headers),
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (loaded.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const wsId = loaded.workspace.id;
    const rows = await input.db
      .select({
        pushSummaryBranches: workspaceSettingsTable.pushSummaryBranches,
        prSummaryBaseBranches: workspaceSettingsTable.prSummaryBaseBranches,
        releaseProjectKind: workspaceSettingsTable.releaseProjectKind,
        releaseVersionFilePath: workspaceSettingsTable.releaseVersionFilePath,
        releaseVersionBranch: workspaceSettingsTable.releaseVersionBranch,
      })
      .from(workspaceSettingsTable)
      .where(eq(workspaceSettingsTable.workspaceId, wsId))
      .limit(1);
    const diagnostics = buildWorkspaceDiagnostics({
      repoFullName: loaded.workspace.repoFullName,
      repoDefaultBranch: loaded.workspace.repoDefaultBranch,
      hasEnabledDestination: await hasEnabledDestination(input.db, wsId),
      settings: rows[0],
    });
    return reply.send({ diagnostics });
  });

  instance.post("/api/me/workspaces/by-slug/:slug/settings/infer", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { slug?: string };
    const loaded = await loadWorkspaceForMember(
      input.db,
      session.userId,
      readTeamIdHeader(request.headers),
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (loaded.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    if (!canWriteWorkspaces(loaded.team.role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }

    const repoFull = loaded.workspace.repoFullName?.trim();
    if (repoFull === undefined || repoFull.length === 0) {
      return reply.status(400).send({ error: "workspace_repo_not_linked" });
    }

    const accessToken = await loadUserGithubAccessToken(
      input.db,
      session.userId,
      input.jwtSecret,
    );
    if (accessToken === null) {
      return reply.status(400).send({ error: "github_not_connected" });
    }

    const parsedBody = inferWorkspaceSettingsBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.status(400).send({ error: "invalid_body" });
    }

    const octokit = new Octokit({ auth: accessToken });
    try {
      const result = await inferAndApplyWorkspaceSettings({
        db: input.db,
        octokit,
        workspaceId: loaded.workspace.id,
        repoFullName: repoFull,
        workspaceDefaultBranch: loaded.workspace.repoDefaultBranch ?? null,
        workspaceKind: loaded.workspace.workspaceKind ?? null,
        apply: parsedBody.data.apply,
      });

      const settingsRows = await input.db
        .select({
          pushSummaryBranches: workspaceSettingsTable.pushSummaryBranches,
          releaseProjectKind: workspaceSettingsTable.releaseProjectKind,
          releaseVersionFilePath: workspaceSettingsTable.releaseVersionFilePath,
          releaseVersionBranch: workspaceSettingsTable.releaseVersionBranch,
        })
        .from(workspaceSettingsTable)
        .where(eq(workspaceSettingsTable.workspaceId, loaded.workspace.id))
        .limit(1);

      const workspaceRows = await input.db
        .select({
          repoFullName: workspacesTable.repoFullName,
          repoDefaultBranch: workspacesTable.repoDefaultBranch,
        })
        .from(workspacesTable)
        .where(eq(workspacesTable.id, loaded.workspace.id))
        .limit(1);
      const workspaceRow = workspaceRows[0];

      const diagnostics = buildWorkspaceDiagnostics({
        repoFullName: workspaceRow?.repoFullName ?? loaded.workspace.repoFullName,
        repoDefaultBranch:
          workspaceRow?.repoDefaultBranch ?? loaded.workspace.repoDefaultBranch,
        hasEnabledDestination: await hasEnabledDestination(input.db, loaded.workspace.id),
        settings: settingsRows[0],
      });

      return reply.send({
        inference: result.inference,
        applied: result.applied,
        skipReason: result.skipReason,
        settings: result.settings,
        diagnostics,
        workspaceDefaultBranchUpdated: result.workspaceDefaultBranchUpdated,
        workspaceKindUpdated: result.workspaceKindUpdated,
      });
    } catch (err: unknown) {
      request.log.warn({ err }, "workspace_settings_infer_failed");
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? Number((err as { status?: unknown }).status)
          : NaN;
      if (status === 404) {
        return reply.status(404).send({ error: "repo_not_found_or_no_access" });
      }
      return reply.status(500).send({ error: "infer_failed" });
    }
  });

  instance.get("/api/me/workspaces/by-slug/:slug/repo/contents", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { slug?: string };
    const loaded = await loadWorkspaceForMember(
      input.db,
      session.userId,
      readTeamIdHeader(request.headers),
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (loaded.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const repoFull = loaded.workspace.repoFullName?.trim();
    if (repoFull === undefined || repoFull.length === 0) {
      return reply.status(400).send({ error: "workspace_repo_not_linked" });
    }

    const accessToken = await loadUserGithubAccessToken(
      input.db,
      session.userId,
      input.jwtSecret,
    );
    if (accessToken === null) {
      return reply.status(400).send({ error: "github_not_connected" });
    }

    const parsedQuery = repoContentsQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.status(400).send({ error: "invalid_query" });
    }
    const pathParam = parsedQuery.data.path.trim();
    const refParam =
      parsedQuery.data.ref?.trim() ||
      loaded.workspace.repoDefaultBranch?.trim() ||
      "main";

    const slash = repoFull.indexOf("/");
    if (slash <= 0 || slash === repoFull.length - 1) {
      return reply.status(400).send({ error: "invalid_repo_full_name" });
    }
    const owner = repoFull.slice(0, slash);
    const repo = repoFull.slice(slash + 1);

    const octokit = new Octokit({ auth: accessToken });
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: pathParam.length > 0 ? pathParam : "",
        ref: refParam,
      });
      if (!Array.isArray(data)) {
        const name = "name" in data && typeof data.name === "string" ? data.name : "";
        const path =
          "path" in data && typeof data.path === "string" ? data.path : pathParam;
        return reply.send({
          ref: refParam,
          requestedPath: pathParam,
          entries: [{ name, path, type: "file" as const }],
        });
      }
      const entries = data
        .filter((e) => e.type === "file" || e.type === "dir")
        .map((e) => ({
          name: e.name,
          path: e.path,
          type: e.type as "file" | "dir",
        }))
        .sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === "dir" ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
      return reply.send({
        ref: refParam,
        requestedPath: pathParam,
        entries,
      });
    } catch (err: unknown) {
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? Number((err as { status?: unknown }).status)
          : NaN;
      if (status === 404) {
        return reply.status(404).send({ error: "repo_path_not_found" });
      }
      request.log.warn({ err }, "workspace_repo_contents_failed");
      return reply.status(500).send({ error: "repo_contents_failed" });
    }
  });

  instance.patch("/api/me/workspaces/by-slug/:slug/settings", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { slug?: string };
    const loaded = await loadWorkspaceForMember(
      input.db,
      session.userId,
      readTeamIdHeader(request.headers),
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (loaded.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    if (!canWriteWorkspaces(loaded.team.role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }

    const parsedBody = patchWorkspaceSettingsBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: "invalid_body" });
    }
    const patch = parsedBody.data;
    const wsId = loaded.workspace.id;
    const now = new Date();

    const mapId = (v: string | null | undefined): string | null | undefined => {
      if (v === undefined) {
        return undefined;
      }
      if (v === null) {
        return null;
      }
      const t = v.trim();
      return t.length === 0 ? null : t;
    };
    const nextBranch = mapId(patch.releaseVersionBranch);

    const mapBranchList = (
      v: string[] | null | undefined,
    ): string[] | null | undefined => {
      if (v === undefined) {
        return undefined;
      }
      if (v === null) {
        return null;
      }
      const cleaned = v.map((b) => b.trim()).filter((b) => b.length > 0);
      return cleaned.length > 0 ? cleaned : null;
    };
    const nextPushBranches = mapBranchList(patch.pushSummaryBranches);

    /* PR base branches keep [] as-is: empty list = PR summaries OFF,
     * null = summarize merges into any branch. */
    const nextPrBaseBranches =
      patch.prSummaryBaseBranches === undefined
        ? undefined
        : patch.prSummaryBaseBranches === null
          ? null
          : patch.prSummaryBaseBranches.map((b) => b.trim()).filter((b) => b.length > 0);

    const mapHistoryList = (
      value: string[] | null | undefined,
      fallback: readonly string[],
    ): string[] | undefined => {
      if (value === undefined) {
        return undefined;
      }
      if (value === null) {
        return [...fallback];
      }
      return [...new Set(value.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
    };
    const nextHistoryExcludedPaths = mapHistoryList(
      patch.historyExcludedPaths,
      DEFAULT_HISTORY_EXCLUDED_PATHS,
    );
    const nextHistoryExcludedActors = mapHistoryList(patch.historyExcludedActors, []);

    const nonBlankOrNull = (s: string | null): string | null => {
      const t = s?.trim();
      return t && t.length > 0 ? t : null;
    };

    let releasePatch: {
      releaseProjectKind?: string | null;
      releaseVersionFilePath?: string | null;
      releaseInfoPlistPath?: string | null;
      releaseProjectPbxprojPath?: string | null;
      releaseExpoAppConfigPath?: string | null;
      releaseVersionBranch?: string | null;
    } = {};

    if (patch.releaseProjectKind !== undefined && patch.releaseVersionFilePath !== undefined) {
      if (patch.releaseProjectKind === null && patch.releaseVersionFilePath === null) {
        releasePatch = {
          releaseProjectKind: null,
          releaseVersionFilePath: null,
          releaseInfoPlistPath: null,
          releaseProjectPbxprojPath: null,
          releaseExpoAppConfigPath: null,
        };
      } else if (patch.releaseProjectKind !== null && patch.releaseVersionFilePath !== null) {
        const applied = applyReleaseKindAndFilePath(
          patch.releaseProjectKind,
          patch.releaseVersionFilePath,
        );
        releasePatch = {
          releaseProjectKind: patch.releaseProjectKind,
          releaseVersionFilePath: patch.releaseVersionFilePath.trim(),
          releaseInfoPlistPath: nonBlankOrNull(applied.releaseInfoPlistPath),
          releaseProjectPbxprojPath: nonBlankOrNull(applied.releaseProjectPbxprojPath),
          releaseExpoAppConfigPath: nonBlankOrNull(applied.releaseExpoAppConfigPath),
        };
      }
    }
    if (nextBranch !== undefined) {
      releasePatch = { ...releasePatch, releaseVersionBranch: nextBranch };
    }

    const existing = await input.db
      .select({ id: workspaceSettingsTable.id })
      .from(workspaceSettingsTable)
      .where(eq(workspaceSettingsTable.workspaceId, wsId))
      .limit(1);
    const existingRow = existing[0];

    if (existingRow !== undefined) {
      await input.db
        .update(workspaceSettingsTable)
        .set({
          ...(nextPushBranches !== undefined ? { pushSummaryBranches: nextPushBranches } : {}),
          ...(nextPrBaseBranches !== undefined
            ? { prSummaryBaseBranches: nextPrBaseBranches }
            : {}),
          ...(nextHistoryExcludedPaths !== undefined
            ? { historyExcludedPaths: nextHistoryExcludedPaths }
            : {}),
          ...(nextHistoryExcludedActors !== undefined
            ? { historyExcludedActors: nextHistoryExcludedActors }
            : {}),
          ...releasePatch,
          updatedAt: now,
        })
        .where(eq(workspaceSettingsTable.id, existingRow.id));
    } else {
      await input.db.insert(workspaceSettingsTable).values({
        workspaceId: wsId,
        pushSummaryBranches: nextPushBranches === undefined ? null : nextPushBranches,
        prSummaryBaseBranches: nextPrBaseBranches === undefined ? null : nextPrBaseBranches,
        historyExcludedPaths:
          nextHistoryExcludedPaths === undefined
            ? [...DEFAULT_HISTORY_EXCLUDED_PATHS]
            : nextHistoryExcludedPaths,
        historyExcludedActors:
          nextHistoryExcludedActors === undefined ? [] : nextHistoryExcludedActors,
        releaseProjectKind:
          releasePatch.releaseProjectKind === undefined ? null : releasePatch.releaseProjectKind,
        releaseVersionFilePath:
          releasePatch.releaseVersionFilePath === undefined
            ? null
            : releasePatch.releaseVersionFilePath,
        releaseInfoPlistPath:
          releasePatch.releaseInfoPlistPath === undefined ? null : releasePatch.releaseInfoPlistPath,
        releaseProjectPbxprojPath:
          releasePatch.releaseProjectPbxprojPath === undefined
            ? null
            : releasePatch.releaseProjectPbxprojPath,
        releaseExpoAppConfigPath:
          releasePatch.releaseExpoAppConfigPath === undefined
            ? null
            : releasePatch.releaseExpoAppConfigPath,
        releaseVersionBranch:
          releasePatch.releaseVersionBranch === undefined ? null : releasePatch.releaseVersionBranch,
        createdAt: now,
        updatedAt: now,
      });
    }

    const rows = await input.db
      .select({
        pushSummaryBranches: workspaceSettingsTable.pushSummaryBranches,
        prSummaryBaseBranches: workspaceSettingsTable.prSummaryBaseBranches,
        releaseProjectKind: workspaceSettingsTable.releaseProjectKind,
        releaseVersionFilePath: workspaceSettingsTable.releaseVersionFilePath,
        releaseVersionBranch: workspaceSettingsTable.releaseVersionBranch,
        historyExcludedPaths: workspaceSettingsTable.historyExcludedPaths,
        historyExcludedActors: workspaceSettingsTable.historyExcludedActors,
      })
      .from(workspaceSettingsTable)
      .where(eq(workspaceSettingsTable.workspaceId, wsId))
      .limit(1);
    const row = rows[0];
    return reply.send({
      settings: {
        pushSummaryBranches: row?.pushSummaryBranches ?? null,
        prSummaryBaseBranches: row?.prSummaryBaseBranches ?? null,
        releaseProjectKind: row?.releaseProjectKind ?? null,
        releaseVersionFilePath: row?.releaseVersionFilePath ?? null,
        releaseVersionBranch: row?.releaseVersionBranch ?? null,
        historyExcludedPaths:
          row?.historyExcludedPaths ?? [...DEFAULT_HISTORY_EXCLUDED_PATHS],
        historyExcludedActors: row?.historyExcludedActors ?? [],
      },
    });
  });

  instance.get("/api/me/workspaces/by-slug/:slug", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { slug?: string };
    const loaded = await loadWorkspaceForMember(
      input.db,
      session.userId,
      readTeamIdHeader(request.headers),
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (loaded.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    return reply.send({ workspace: loaded.workspace });
  });

  /**
   * Aha-moment sample (Fase 3d): right after a workspace is created, enqueue a
   * process_pr job for the repo's latest merged PR so the feed isn't empty on
   * first visit. Best-effort — any GitHub/queue failure is swallowed by the
   * fire-and-forget call site and never blocks or fails the create.
   */
  const enqueueSampleSummary = async (
    userId: string,
    repoFullName: string,
  ): Promise<void> => {
    const accessToken = await loadUserGithubAccessToken(
      input.db,
      userId,
      input.jwtSecret,
    );
    if (typeof accessToken !== "string") {
      return;
    }
    const [owner, repoName] = repoFullName.split("/");
    if (owner === undefined || repoName === undefined || repoName.length === 0) {
      return;
    }
    const octokit = new Octokit({ auth: accessToken });
    // GitHub has no "merged" list filter — closed sorted by recency is the proxy.
    const { data } = await octokit.rest.pulls.list({
      owner,
      repo: repoName,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 20,
    });
    const merged = data.find((pull) => pull.merged_at != null);
    if (merged === undefined) {
      return;
    }
    await input.db.insert(jobsTable).values({
      type: "process_pr",
      payload: { repo: repoFullName, prNumber: merged.number },
      status: "pending",
    });
  };

  instance.post("/api/me/workspaces", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const parsedBody = createWorkspaceBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: "invalid_body" });
    }

    const {
      sourceProvider,
      repoFullName,
      repoDefaultBranch: branchRaw,
      name: nameRaw,
      workspaceKind: kindRaw,
    } = parsedBody.data;

    // Only providers with a runtime implementation can be linked today.
    if (!isImplementedProvider(sourceProvider)) {
      return reply.status(400).send({ error: "unsupported_provider" });
    }

    const repoFull = repoFullName.trim();
    const repoDefaultBranch = branchRaw?.trim() ? branchRaw.trim() : null;
    const name = (nameRaw?.trim() ?? "").length > 0 ? nameRaw!.trim() : nameFromRepoFullName(repoFull);

    const baseSlug = slugFromRepoFullName(repoFull);

    let workspaceKind: string | null = null;
    if (kindRaw !== undefined) {
      const kindParsed = releaseProjectKindSchema.safeParse(kindRaw.trim().toLowerCase());
      if (!kindParsed.success) {
        return reply.status(400).send({ error: "invalid_workspace_kind" });
      }
      workspaceKind = kindParsed.data;
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
    if (!canWriteWorkspaces(team.context.role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }

    const now = new Date();
    // Derive a per-team-unique slug; retry with a numeric suffix on slug collision.
    const maxSlugAttempts = 25;
    for (let attempt = 1; attempt <= maxSlugAttempts; attempt += 1) {
      const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
      try {
        const inserted = await input.db
          .insert(workspacesTable)
          .values({
            teamId: team.context.teamId,
            userId: session.userId,
            name,
            slug,
            sourceProvider,
            workspaceKind,
            repoFullName: repoFull,
            repoDefaultBranch,
            createdAt: now,
            updatedAt: now,
          })
          .returning(workspaceRowSelect);

        const row = inserted[0];
        if (row === undefined) {
          return reply.status(500).send({ error: "insert_failed" });
        }
        void enqueueSampleSummary(session.userId, repoFull).catch((err: unknown) => {
          request.log.warn({ err }, "sample_summary_enqueue_failed");
        });
        return reply.status(201).send({ workspace: row });
      } catch (err) {
        const constraint = uniqueViolationTarget(err);
        if (constraint === "workspaces_provider_repo_unique") {
          return reply.status(409).send({ error: "repo_already_linked" });
        }
        if (constraint === "workspaces_team_id_slug_unique") {
          // Slug collision for this user — try the next suffixed slug.
          continue;
        }
        if (isUniqueViolation(err)) {
          return reply.status(409).send({ error: "workspace_conflict" });
        }
        request.log.warn({ err }, "create_workspace_failed");
        return reply.status(500).send({ error: "internal_error" });
      }
    }
    return reply.status(409).send({ error: "workspace_slug_taken" });
  });

  instance.patch("/api/me/workspaces/:workspaceId", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { workspaceId?: string };
    const workspaceIdParsed = workspaceIdParamSchema.safeParse(params.workspaceId);
    if (!workspaceIdParsed.success) {
      return reply.status(400).send({ error: "invalid_workspace_id" });
    }
    const workspaceId = workspaceIdParsed.data;

    const parsedBody = patchWorkspaceBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: "invalid_body" });
    }
    const patch = parsedBody.data;

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
    if (!canWriteWorkspaces(team.context.role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }

    const now = new Date();
    const updated = await input.db
      .update(workspacesTable)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.workspaceKind !== undefined ? { workspaceKind: patch.workspaceKind } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(workspacesTable.id, workspaceId),
          eq(workspacesTable.teamId, team.context.teamId),
        ),
      )
      .returning(workspaceRowSelect);

    const row = updated[0];
    if (row === undefined) {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    return reply.send({ workspace: row });
  });

  instance.delete("/api/me/workspaces/:workspaceId", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { workspaceId?: string };
    const workspaceIdParsed = workspaceIdParamSchema.safeParse(params.workspaceId);
    if (!workspaceIdParsed.success) {
      return reply.status(400).send({ error: "invalid_workspace_id" });
    }
    const workspaceId = workspaceIdParsed.data;

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
    if (!canWriteWorkspaces(team.context.role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }

    // Verify team ownership and capture the linked repo before deleting anything.
    const owned = await input.db
      .select({ repoFullName: workspacesTable.repoFullName })
      .from(workspacesTable)
      .where(
        and(
          eq(workspacesTable.id, workspaceId),
          eq(workspacesTable.teamId, team.context.teamId),
        ),
      )
      .limit(1);
    const ownedRow = owned[0];
    if (ownedRow === undefined) {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    // Wipe the repo's summary history so a recreated workspace reprocesses from scratch.
    // Summary tables are keyed on `repo` only (no workspace FK); `(provider, repo)` uniqueness
    // guarantees a single workspace owns the repo, so deleting by repo name is safe today.
    const repo = ownedRow.repoFullName?.trim();
    if (repo !== undefined && repo.length > 0) {
      await input.db.delete(pullRequestsTable).where(eq(pullRequestsTable.repo, repo));
      await input.db.delete(releasesTable).where(eq(releasesTable.repo, repo));
      await input.db.delete(pushesTable).where(eq(pushesTable.repo, repo));
    }

    // Delete the workspace last (workspace_settings cascades via FK).
    await input.db
      .delete(workspacesTable)
      .where(
        and(
          eq(workspacesTable.id, workspaceId),
          eq(workspacesTable.teamId, team.context.teamId),
        ),
      );

    return reply.status(204).send();
  });
};
