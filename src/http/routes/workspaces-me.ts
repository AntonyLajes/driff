import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { verifySessionJwt } from "@/auth/session-jwt.js";
import { releaseProjectKindSchema } from "@/config/release-project-kind.js";
import type { Database } from "@/db/client.js";
import { pullRequestsTable, releasesTable, workspacesTable } from "@/db/schema.js";
import { normalizeWorkspaceSlug, slugifyWorkspaceName } from "@/lib/workspace-slug.js";

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
