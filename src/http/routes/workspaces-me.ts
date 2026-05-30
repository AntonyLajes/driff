import type { FastifyInstance } from "fastify";
import { Octokit } from "@octokit/rest";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { verifySessionJwt } from "@/auth/session-jwt.js";
import {
  applyReleaseKindAndFilePath,
  isSupportedReleaseProjectKind,
  releaseProjectKindSchema,
} from "@/config/release-project-kind.js";
import { execute as loadEnv } from "@/config/env.js";
import type { Database } from "@/db/client.js";
import { pullRequestsTable, releasesTable, workspaceSettingsTable, workspacesTable } from "@/db/schema.js";
import { loadUserGithubAccessToken } from "@/github/load-user-github-access-token.js";
import { normalizeWorkspaceSlug, slugifyWorkspaceName } from "@/lib/workspace-slug.js";
import { inferAndApplyWorkspaceSettings } from "@/workspaces/infer-workspace-settings.js";
import {
  listNotionDatabases,
  suggestNotionDatabaseRoles,
} from "@/notion/list-databases.js";

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

const createWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  workspaceKind: z.string().min(1).max(64).optional(),
});

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  "code" in err &&
  (err as { code?: string }).code === "23505";

const workspaceIdParamSchema = z.string().uuid();

const repoFullNameSchema = z
  .string()
  .min(3)
  .max(241)
  .regex(/^[\w.-]+\/[\w.-]+$/u, "expected owner/repo");

const patchWorkspaceBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    workspaceKind: z.union([releaseProjectKindSchema, z.null()]).optional(),
    githubRepoFullName: z.union([repoFullNameSchema, z.null()]).optional(),
    githubRepoDefaultBranch: z.union([z.string().min(1).max(255), z.null()]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "empty_patch" });

const workspaceRowSelect = {
  id: workspacesTable.id,
  name: workspacesTable.name,
  slug: workspacesTable.slug,
  workspaceKind: workspacesTable.workspaceKind,
  githubRepoFullName: workspacesTable.githubRepoFullName,
  githubRepoDefaultBranch: workspacesTable.githubRepoDefaultBranch,
  createdAt: workspacesTable.createdAt,
  updatedAt: workspacesTable.updatedAt,
};

const patchWorkspaceSettingsBodySchema = z
  .object({
    notionPrDatabaseId: z.union([z.string().max(128), z.null()]).optional(),
    notionReleasesDatabaseId: z.union([z.string().max(128), z.null()]).optional(),
    notionPushesDatabaseId: z.union([z.string().max(128), z.null()]).optional(),
    pushSummaryBranches: z.union([z.array(z.string().min(1).max(255)).max(50), z.null()]).optional(),
    releaseProjectKind: z.union([releaseProjectKindSchema, z.null()]).optional(),
    releaseVersionFilePath: z.union([z.string().max(512), z.null()]).optional(),
    releaseVersionBranch: z.union([z.string().max(255), z.null()]).optional(),
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

const repoContentsQuerySchema = z.object({
  path: z.string().max(2048).optional().default(""),
  ref: z.string().min(1).max(255).optional(),
});

const inferWorkspaceSettingsBodySchema = z.object({
  apply: z.boolean().optional().default(true),
});

const loadWorkspaceBySlugForUser = async (db: Database, userId: string, slugParam: string) => {
  const slug = normalizeWorkspaceSlug(slugParam);
  if (slug.length === 0 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { kind: "invalid_slug" as const };
  }
  const rows = await db
    .select(workspaceRowSelect)
    .from(workspacesTable)
    .where(and(eq(workspacesTable.userId, userId), eq(workspacesTable.slug, slug)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { kind: "not_found" as const };
  }
  return { kind: "ok" as const, workspace: row };
};

type WorkspaceDiagnosticsIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
};

const buildWorkspaceDiagnostics = (input: {
  githubRepoFullName: string | null;
  githubRepoDefaultBranch: string | null;
  settings:
    | {
        notionPrDatabaseId: string | null;
        notionReleasesDatabaseId: string | null;
        notionPushesDatabaseId?: string | null;
        pushSummaryBranches?: string[] | null;
        releaseProjectKind: string | null;
        releaseVersionFilePath: string | null;
        releaseVersionBranch: string | null;
      }
    | undefined;
}) => {
  const repo = input.githubRepoFullName?.trim() ?? "";
  const defaultBranch = input.githubRepoDefaultBranch?.trim() || "main";
  const settings = input.settings;

  const prDb = settings?.notionPrDatabaseId?.trim() ?? "";
  const releasesDb = settings?.notionReleasesDatabaseId?.trim() ?? "";
  const releaseKind = settings?.releaseProjectKind?.trim() ?? "";
  const releasePath = settings?.releaseVersionFilePath?.trim() ?? "";
  const releaseBranch = settings?.releaseVersionBranch?.trim() ?? "";
  const pushesDb = settings?.notionPushesDatabaseId?.trim() ?? "";
  const pushBranches = (settings?.pushSummaryBranches ?? [])
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const issues: WorkspaceDiagnosticsIssue[] = [];

  if (repo.length === 0) {
    issues.push({
      code: "workspace_repo_not_linked",
      severity: "error",
      message: "Link a GitHub repository to this workspace.",
    });
  }
  if (!settings) {
    issues.push({
      code: "workspace_settings_missing",
      severity: "error",
      message: "Create workspace settings for this workspace.",
    });
  }
  if (!prDb) {
    issues.push({
      code: "notion_pr_database_id_missing",
      severity: "error",
      message: "Set Notion PR database id in workspace settings.",
    });
  }
  if (releasesDb && !releaseBranch) {
    issues.push({
      code: "release_branch_missing",
      severity: "error",
      message: "Release database is configured but release branch is missing.",
    });
  }
  if (releasesDb && (!releaseKind || !releasePath)) {
    issues.push({
      code: "release_version_source_missing",
      severity: "error",
      message: "Release database is configured but release project kind/file path is missing.",
    });
  }
  if (!releasesDb) {
    issues.push({
      code: "notion_releases_database_id_missing",
      severity: "warning",
      message: "Set Notion releases database id to enable version summaries.",
    });
  }
  if (!pushesDb) {
    issues.push({
      code: "notion_pushes_database_id_missing",
      severity: "warning",
      message: "Set Notion pushes database id to enable direct-push summaries.",
    });
  }

  const prSummaryReady = repo.length > 0 && !!settings && prDb.length > 0;
  const releaseSummaryReady =
    prSummaryReady &&
    releasesDb.length > 0 &&
    releaseBranch.length > 0 &&
    releaseKind.length > 0 &&
    releasePath.length > 0;
  // Push summaries fall back to the repo default branch when no explicit branch list is set.
  const pushSummaryReady =
    repo.length > 0 &&
    !!settings &&
    pushesDb.length > 0 &&
    (pushBranches.length > 0 || defaultBranch.length > 0);

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
      workspaceSettingsPresent: Boolean(settings),
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

    const rows = await input.db
      .select(workspaceRowSelect)
      .from(workspacesTable)
      .where(eq(workspacesTable.userId, session.userId))
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
    const loaded = await loadWorkspaceBySlugForUser(
      input.db,
      session.userId,
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const repo = loaded.workspace.githubRepoFullName?.trim();
    if (repo === undefined || repo.length === 0) {
      return reply.send({ releases: [], pullRequests: [] });
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

    return reply.send({ releases, pullRequests: prRows });
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
    const loaded = await loadWorkspaceBySlugForUser(
      input.db,
      session.userId,
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const wsId = loaded.workspace.id;
    const rows = await input.db
      .select({
        notionPrDatabaseId: workspaceSettingsTable.notionPrDatabaseId,
        notionReleasesDatabaseId: workspaceSettingsTable.notionReleasesDatabaseId,
        notionPushesDatabaseId: workspaceSettingsTable.notionPushesDatabaseId,
        pushSummaryBranches: workspaceSettingsTable.pushSummaryBranches,
        releaseProjectKind: workspaceSettingsTable.releaseProjectKind,
        releaseVersionFilePath: workspaceSettingsTable.releaseVersionFilePath,
        releaseVersionBranch: workspaceSettingsTable.releaseVersionBranch,
      })
      .from(workspaceSettingsTable)
      .where(eq(workspaceSettingsTable.workspaceId, wsId))
      .limit(1);
    const row = rows[0];
    return reply.send({
      settings: {
        notionPrDatabaseId: row?.notionPrDatabaseId ?? null,
        notionReleasesDatabaseId: row?.notionReleasesDatabaseId ?? null,
        notionPushesDatabaseId: row?.notionPushesDatabaseId ?? null,
        pushSummaryBranches: row?.pushSummaryBranches ?? null,
        releaseProjectKind: row?.releaseProjectKind ?? null,
        releaseVersionFilePath: row?.releaseVersionFilePath ?? null,
        releaseVersionBranch: row?.releaseVersionBranch ?? null,
      },
    });
  });

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
    const loaded = await loadWorkspaceBySlugForUser(
      input.db,
      session.userId,
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const wsId = loaded.workspace.id;
    const rows = await input.db
      .select({
        notionPrDatabaseId: workspaceSettingsTable.notionPrDatabaseId,
        notionReleasesDatabaseId: workspaceSettingsTable.notionReleasesDatabaseId,
        notionPushesDatabaseId: workspaceSettingsTable.notionPushesDatabaseId,
        pushSummaryBranches: workspaceSettingsTable.pushSummaryBranches,
        releaseProjectKind: workspaceSettingsTable.releaseProjectKind,
        releaseVersionFilePath: workspaceSettingsTable.releaseVersionFilePath,
        releaseVersionBranch: workspaceSettingsTable.releaseVersionBranch,
      })
      .from(workspaceSettingsTable)
      .where(eq(workspaceSettingsTable.workspaceId, wsId))
      .limit(1);
    const diagnostics = buildWorkspaceDiagnostics({
      githubRepoFullName: loaded.workspace.githubRepoFullName,
      githubRepoDefaultBranch: loaded.workspace.githubRepoDefaultBranch,
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
    const loaded = await loadWorkspaceBySlugForUser(
      input.db,
      session.userId,
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const repoFull = loaded.workspace.githubRepoFullName?.trim();
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
        workspaceDefaultBranch: loaded.workspace.githubRepoDefaultBranch ?? null,
        workspaceKind: loaded.workspace.workspaceKind ?? null,
        apply: parsedBody.data.apply,
      });

      const settingsRows = await input.db
        .select({
          notionPrDatabaseId: workspaceSettingsTable.notionPrDatabaseId,
          notionReleasesDatabaseId: workspaceSettingsTable.notionReleasesDatabaseId,
          releaseProjectKind: workspaceSettingsTable.releaseProjectKind,
          releaseVersionFilePath: workspaceSettingsTable.releaseVersionFilePath,
          releaseVersionBranch: workspaceSettingsTable.releaseVersionBranch,
        })
        .from(workspaceSettingsTable)
        .where(eq(workspaceSettingsTable.workspaceId, loaded.workspace.id))
        .limit(1);

      const workspaceRows = await input.db
        .select({
          githubRepoFullName: workspacesTable.githubRepoFullName,
          githubRepoDefaultBranch: workspacesTable.githubRepoDefaultBranch,
        })
        .from(workspacesTable)
        .where(eq(workspacesTable.id, loaded.workspace.id))
        .limit(1);
      const workspaceRow = workspaceRows[0];

      const diagnostics = buildWorkspaceDiagnostics({
        githubRepoFullName: workspaceRow?.githubRepoFullName ?? loaded.workspace.githubRepoFullName,
        githubRepoDefaultBranch:
          workspaceRow?.githubRepoDefaultBranch ?? loaded.workspace.githubRepoDefaultBranch,
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

  instance.get("/api/me/workspaces/by-slug/:slug/integrations/notion/status", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { slug?: string };
    const loaded = await loadWorkspaceBySlugForUser(
      input.db,
      session.userId,
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const notionToken = loadEnv().NOTION_TOKEN.trim();
    if (notionToken.length === 0) {
      return reply.send({ status: { tokenConfigured: false, reachable: false } });
    }

    try {
      await listNotionDatabases(notionToken);
      return reply.send({ status: { tokenConfigured: true, reachable: true } });
    } catch (err) {
      request.log.warn({ err }, "notion_status_check_failed");
      return reply.send({ status: { tokenConfigured: true, reachable: false } });
    }
  });

  instance.get("/api/me/workspaces/by-slug/:slug/integrations/notion/databases", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const params = request.params as { slug?: string };
    const loaded = await loadWorkspaceBySlugForUser(
      input.db,
      session.userId,
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const notionToken = loadEnv().NOTION_TOKEN.trim();
    if (notionToken.length === 0) {
      return reply.status(503).send({ error: "notion_not_configured" });
    }

    try {
      const databases = await listNotionDatabases(notionToken);
      const suggestions = suggestNotionDatabaseRoles(databases);
      return reply.send({ databases, suggestions });
    } catch (err) {
      request.log.warn({ err }, "notion_list_databases_failed");
      return reply.status(502).send({ error: "notion_list_failed" });
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
    const loaded = await loadWorkspaceBySlugForUser(
      input.db,
      session.userId,
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }

    const repoFull = loaded.workspace.githubRepoFullName?.trim();
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
      loaded.workspace.githubRepoDefaultBranch?.trim() ||
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
    const loaded = await loadWorkspaceBySlugForUser(
      input.db,
      session.userId,
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
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
    const nextPr = mapId(patch.notionPrDatabaseId);
    const nextRel = mapId(patch.notionReleasesDatabaseId);
    const nextPushes = mapId(patch.notionPushesDatabaseId);
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
          ...(nextPr !== undefined ? { notionPrDatabaseId: nextPr } : {}),
          ...(nextRel !== undefined ? { notionReleasesDatabaseId: nextRel } : {}),
          ...(nextPushes !== undefined ? { notionPushesDatabaseId: nextPushes } : {}),
          ...(nextPushBranches !== undefined ? { pushSummaryBranches: nextPushBranches } : {}),
          ...releasePatch,
          updatedAt: now,
        })
        .where(eq(workspaceSettingsTable.id, existingRow.id));
    } else {
      await input.db.insert(workspaceSettingsTable).values({
        workspaceId: wsId,
        notionPrDatabaseId: nextPr === undefined ? null : nextPr,
        notionReleasesDatabaseId: nextRel === undefined ? null : nextRel,
        notionPushesDatabaseId: nextPushes === undefined ? null : nextPushes,
        pushSummaryBranches: nextPushBranches === undefined ? null : nextPushBranches,
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
        notionPrDatabaseId: workspaceSettingsTable.notionPrDatabaseId,
        notionReleasesDatabaseId: workspaceSettingsTable.notionReleasesDatabaseId,
        notionPushesDatabaseId: workspaceSettingsTable.notionPushesDatabaseId,
        pushSummaryBranches: workspaceSettingsTable.pushSummaryBranches,
        releaseProjectKind: workspaceSettingsTable.releaseProjectKind,
        releaseVersionFilePath: workspaceSettingsTable.releaseVersionFilePath,
        releaseVersionBranch: workspaceSettingsTable.releaseVersionBranch,
      })
      .from(workspaceSettingsTable)
      .where(eq(workspaceSettingsTable.workspaceId, wsId))
      .limit(1);
    const row = rows[0];
    return reply.send({
      settings: {
        notionPrDatabaseId: row?.notionPrDatabaseId ?? null,
        notionReleasesDatabaseId: row?.notionReleasesDatabaseId ?? null,
        notionPushesDatabaseId: row?.notionPushesDatabaseId ?? null,
        pushSummaryBranches: row?.pushSummaryBranches ?? null,
        releaseProjectKind: row?.releaseProjectKind ?? null,
        releaseVersionFilePath: row?.releaseVersionFilePath ?? null,
        releaseVersionBranch: row?.releaseVersionBranch ?? null,
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
    const loaded = await loadWorkspaceBySlugForUser(
      input.db,
      session.userId,
      params.slug ?? "",
    );
    if (loaded.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (loaded.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    return reply.send({ workspace: loaded.workspace });
  });

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

    const { name, slug: slugInput, workspaceKind: kindRaw } = parsedBody.data;
    let slug =
      slugInput !== undefined ? normalizeWorkspaceSlug(slugInput) : slugifyWorkspaceName(name);
    if (slug.length === 0) {
      slug = "workspace";
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      return reply.status(400).send({ error: "invalid_slug" });
    }

    let workspaceKind: string | null = null;
    if (kindRaw !== undefined) {
      const kindParsed = releaseProjectKindSchema.safeParse(kindRaw.trim().toLowerCase());
      if (!kindParsed.success) {
        return reply.status(400).send({ error: "invalid_workspace_kind" });
      }
      workspaceKind = kindParsed.data;
    }

    const now = new Date();
    try {
      const inserted = await input.db
        .insert(workspacesTable)
        .values({
          userId: session.userId,
          name: name.trim(),
          slug,
          workspaceKind,
          createdAt: now,
          updatedAt: now,
        })
        .returning(workspaceRowSelect);

      const row = inserted[0];
      if (row === undefined) {
        return reply.status(500).send({ error: "insert_failed" });
      }
      return reply.status(201).send({ workspace: row });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.status(409).send({ error: "workspace_slug_taken" });
      }
      request.log.warn({ err }, "create_workspace_failed");
      return reply.status(500).send({ error: "internal_error" });
    }
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

    const now = new Date();
    const updated = await input.db
      .update(workspacesTable)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.workspaceKind !== undefined ? { workspaceKind: patch.workspaceKind } : {}),
        ...(patch.githubRepoFullName !== undefined
          ? { githubRepoFullName: patch.githubRepoFullName }
          : {}),
        ...(patch.githubRepoDefaultBranch !== undefined
          ? { githubRepoDefaultBranch: patch.githubRepoDefaultBranch }
          : {}),
        updatedAt: now,
      })
      .where(
        and(eq(workspacesTable.id, workspaceId), eq(workspacesTable.userId, session.userId)),
      )
      .returning(workspaceRowSelect);

    const row = updated[0];
    if (row === undefined) {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    return reply.send({ workspace: row });
  });
};
