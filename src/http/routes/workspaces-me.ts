import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { verifySessionJwt } from "@/auth/session-jwt.js";
import { releaseProjectKindSchema } from "@/config/release-project-kind.js";
import type { Database } from "@/db/client.js";
import { workspacesTable } from "@/db/schema.js";
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
      .select({
        id: workspacesTable.id,
        name: workspacesTable.name,
        slug: workspacesTable.slug,
        workspaceKind: workspacesTable.workspaceKind,
        createdAt: workspacesTable.createdAt,
        updatedAt: workspacesTable.updatedAt,
      })
      .from(workspacesTable)
      .where(eq(workspacesTable.userId, session.userId))
      .orderBy(desc(workspacesTable.createdAt));

    return reply.send({ workspaces: [...rows] });
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
        .returning({
          id: workspacesTable.id,
          name: workspacesTable.name,
          slug: workspacesTable.slug,
          workspaceKind: workspacesTable.workspaceKind,
          createdAt: workspacesTable.createdAt,
          updatedAt: workspacesTable.updatedAt,
        });

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
};
