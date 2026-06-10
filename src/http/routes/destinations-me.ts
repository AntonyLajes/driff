import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  signDestinationOAuthState,
  verifyDestinationOAuthState,
} from "@/auth/destination-oauth-state.js";
import { verifySessionJwt } from "@/auth/session-jwt.js";
import { openSecret, sealSecret } from "@/auth/token-aes.js";
import type { Env } from "@/config/env.js";
import type { Database } from "@/db/client.js";
import { workspaceDestinationsTable, workspacesTable } from "@/db/schema.js";
import { destinationTypeSchema } from "@/destinations/registry.js";
import { listNotionDatabases, suggestNotionDatabaseRoles } from "@/notion/list-databases.js";
import { normalizeWorkspaceSlug } from "@/lib/workspace-slug.js";
import {
  canWriteWorkspaces,
  readTeamIdHeader,
  resolveTeamContext,
  type TeamRole,
} from "@/teams/team-context.js";

const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

export interface DestinationsMeRegistrationInput {
  db: Database;
  jwtSecret: string;
  notionClientId: string;
  notionClientSecret: string;
  publicApiUrl: string;
  frontendUrl: string;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export const buildDestinationsMeRegistrationInput = (
  env: Env,
): Omit<DestinationsMeRegistrationInput, "db"> | undefined => {
  if (
    env.NOTION_OAUTH_CLIENT_ID === undefined ||
    env.NOTION_OAUTH_CLIENT_SECRET === undefined ||
    env.AUTH_JWT_SECRET === undefined ||
    env.AUTH_PUBLIC_URL === undefined ||
    env.FRONTEND_URL === undefined
  ) {
    return undefined;
  }
  return {
    jwtSecret: env.AUTH_JWT_SECRET,
    notionClientId: env.NOTION_OAUTH_CLIENT_ID,
    notionClientSecret: env.NOTION_OAUTH_CLIENT_SECRET,
    publicApiUrl: trimTrailingSlash(env.AUTH_PUBLIC_URL),
    frontendUrl: trimTrailingSlash(env.FRONTEND_URL),
  };
};

const readBearerToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

const loadWorkspaceForUser = async (
  db: Database,
  userId: string,
  requestedTeamId: string | undefined,
  slugParam: string,
): Promise<
  | { kind: "ok"; id: string; slug: string; role: TeamRole }
  | { kind: "invalid_slug" }
  | { kind: "not_found" }
  | { kind: "invalid_team" }
  | { kind: "not_a_member" }
> => {
  const teamResult = await resolveTeamContext(db, userId, requestedTeamId);
  if (teamResult.kind !== "ok") {
    return { kind: teamResult.kind };
  }
  const slug = normalizeWorkspaceSlug(slugParam);
  if (slug.length === 0 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { kind: "invalid_slug" };
  }
  const rows = await db
    .select({ id: workspacesTable.id, slug: workspacesTable.slug })
    .from(workspacesTable)
    .where(
      and(
        eq(workspacesTable.teamId, teamResult.context.teamId),
        eq(workspacesTable.slug, slug),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { kind: "not_found" };
  }
  return { kind: "ok", id: row.id, slug: row.slug, role: teamResult.context.role };
};

const exchangeNotionCode = async (input: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; workspaceId: string | null; workspaceName: string | null }> => {
  const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`, "utf8").toString("base64");
  const response = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`notion_token_http_${response.status}:${text}`);
  }
  const json = (await response.json()) as {
    access_token?: string;
    workspace_id?: string;
    workspace_name?: string;
  };
  if (typeof json.access_token !== "string") {
    throw new Error("notion_token_missing_access_token");
  }
  return {
    accessToken: json.access_token,
    workspaceId: typeof json.workspace_id === "string" ? json.workspace_id : null,
    workspaceName: typeof json.workspace_name === "string" ? json.workspace_name : null,
  };
};

const notionConfigSchema = z
  .object({
    prDatabaseId: z.union([z.string().max(128), z.null()]).optional(),
    releasesDatabaseId: z.union([z.string().max(128), z.null()]).optional(),
    pushesDatabaseId: z.union([z.string().max(128), z.null()]).optional(),
  })
  .strict();

const patchDestinationBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    config: notionConfigSchema.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "empty_patch" });

const cleanId = (v: string | null | undefined): string | null | undefined => {
  if (v === undefined) {
    return undefined;
  }
  if (v === null) {
    return null;
  }
  const t = v.trim();
  return t.length === 0 ? null : t;
};

export const handler = async (
  instance: FastifyInstance,
  input: DestinationsMeRegistrationInput,
): Promise<void> => {
  const redirectUri = `${input.publicApiUrl}/api/me/destinations/notion/oauth/callback`;

  const requireSession = (request: { headers: { authorization?: string } }) => {
    const bearer = readBearerToken(request.headers.authorization);
    if (bearer === null) {
      return null;
    }
    return verifySessionJwt(bearer, input.jwtSecret);
  };

  instance.post(
    "/api/me/workspaces/by-slug/:slug/destinations/notion/oauth/start",
    async (request, reply) => {
      const session = requireSession(request);
      if (session === null) {
        return reply.status(401).send({ error: "invalid_session" });
      }
      const params = request.params as { slug?: string };
      const ws = await loadWorkspaceForUser(
        input.db,
        session.userId,
        readTeamIdHeader(request.headers),
        params.slug ?? "",
      );
      if (ws.kind === "invalid_team") {
        return reply.status(400).send({ error: "invalid_team" });
      }
      if (ws.kind === "not_a_member") {
        return reply.status(403).send({ error: "not_a_team_member" });
      }
      if (ws.kind === "invalid_slug") {
        return reply.status(400).send({ error: "invalid_slug" });
      }
      if (ws.kind === "not_found") {
        return reply.status(404).send({ error: "workspace_not_found" });
      }
      if (!canWriteWorkspaces(ws.role)) {
        return reply.status(403).send({ error: "insufficient_role" });
      }
      const state = signDestinationOAuthState({
        userId: session.userId,
        workspaceId: ws.id,
        secret: input.jwtSecret,
      });
      const qs = new URLSearchParams({
        client_id: input.notionClientId,
        response_type: "code",
        owner: "user",
        redirect_uri: redirectUri,
        state,
      });
      return reply.send({ authorizeUrl: `${NOTION_AUTHORIZE_URL}?${qs.toString()}` });
    },
  );

  instance.get("/api/me/destinations/notion/oauth/callback", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const code = query.code;
    const state = query.state;
    const frontend = input.frontendUrl;

    const verified = typeof state === "string" ? verifyDestinationOAuthState(state, input.jwtSecret) : null;
    if (typeof code !== "string" || verified === null) {
      return reply.redirect(`${frontend}/workspaces?notion_oauth=error`, 302);
    }

    const slugRows = await input.db
      .select({ slug: workspacesTable.slug })
      .from(workspacesTable)
      .where(eq(workspacesTable.id, verified.workspaceId))
      .limit(1);
    const slug = slugRows[0]?.slug;
    const back = (status: string): string =>
      slug
        ? `${frontend}/workspaces/${encodeURIComponent(slug)}/integrations?notion_oauth=${status}`
        : `${frontend}/workspaces?notion_oauth=${status}`;

    try {
      const bundle = await exchangeNotionCode({
        code,
        redirectUri,
        clientId: input.notionClientId,
        clientSecret: input.notionClientSecret,
      });
      const now = new Date();
      const secretCiphertext = sealSecret(bundle.accessToken, input.jwtSecret);
      await input.db
        .insert(workspaceDestinationsTable)
        .values({
          workspaceId: verified.workspaceId,
          type: "notion",
          enabled: true,
          config: { workspaceName: bundle.workspaceName },
          secretCiphertext,
          externalAccountId: bundle.workspaceId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [workspaceDestinationsTable.workspaceId, workspaceDestinationsTable.type],
          set: {
            secretCiphertext,
            externalAccountId: bundle.workspaceId,
            enabled: true,
            updatedAt: now,
          },
        });
      return reply.redirect(back("success"), 302);
    } catch (err) {
      request.log.warn({ err }, "notion_oauth_callback_failed");
      return reply.redirect(back("exchange_failed"), 302);
    }
  });

  instance.get("/api/me/workspaces/by-slug/:slug/destinations", async (request, reply) => {
    const session = requireSession(request);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const params = request.params as { slug?: string };
    const ws = await loadWorkspaceForUser(
        input.db,
        session.userId,
        readTeamIdHeader(request.headers),
        params.slug ?? "",
      );
    if (ws.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (ws.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (ws.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (ws.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    const rows = await input.db
      .select({
        type: workspaceDestinationsTable.type,
        enabled: workspaceDestinationsTable.enabled,
        config: workspaceDestinationsTable.config,
        secretCiphertext: workspaceDestinationsTable.secretCiphertext,
        externalAccountId: workspaceDestinationsTable.externalAccountId,
      })
      .from(workspaceDestinationsTable)
      .where(eq(workspaceDestinationsTable.workspaceId, ws.id));
    return reply.send({
      destinations: rows.map((r) => ({
        type: r.type,
        enabled: r.enabled,
        connected: Boolean(r.secretCiphertext),
        config: r.config ?? {},
        externalAccountId: r.externalAccountId ?? null,
      })),
    });
  });

  instance.patch("/api/me/workspaces/by-slug/:slug/destinations/:type", async (request, reply) => {
    const session = requireSession(request);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const params = request.params as { slug?: string; type?: string };
    const typeParsed = destinationTypeSchema.safeParse(params.type);
    if (!typeParsed.success) {
      return reply.status(400).send({ error: "invalid_destination_type" });
    }
    const ws = await loadWorkspaceForUser(
        input.db,
        session.userId,
        readTeamIdHeader(request.headers),
        params.slug ?? "",
      );
    if (ws.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (ws.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (ws.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (ws.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    if (!canWriteWorkspaces(ws.role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }
    const body = patchDestinationBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "invalid_body" });
    }

    const existing = await input.db
      .select({
        id: workspaceDestinationsTable.id,
        config: workspaceDestinationsTable.config,
      })
      .from(workspaceDestinationsTable)
      .where(
        and(
          eq(workspaceDestinationsTable.workspaceId, ws.id),
          eq(workspaceDestinationsTable.type, typeParsed.data),
        ),
      )
      .limit(1);
    const existingRow = existing[0];
    if (existingRow === undefined) {
      return reply.status(404).send({ error: "destination_not_connected" });
    }

    const nextConfig: Record<string, unknown> = { ...(existingRow.config ?? {}) };
    if (body.data.config) {
      const c = body.data.config;
      const apply = (key: string, value: string | null | undefined) => {
        const mapped = cleanId(value);
        if (mapped === undefined) {
          return;
        }
        if (mapped === null) {
          delete nextConfig[key];
        } else {
          nextConfig[key] = mapped;
        }
      };
      apply("prDatabaseId", c.prDatabaseId);
      apply("releasesDatabaseId", c.releasesDatabaseId);
      apply("pushesDatabaseId", c.pushesDatabaseId);
    }

    await input.db
      .update(workspaceDestinationsTable)
      .set({
        config: nextConfig,
        ...(body.data.enabled !== undefined ? { enabled: body.data.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workspaceDestinationsTable.id, existingRow.id));

    return reply.send({
      destination: { type: typeParsed.data, config: nextConfig },
    });
  });

  instance.delete("/api/me/workspaces/by-slug/:slug/destinations/:type", async (request, reply) => {
    const session = requireSession(request);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const params = request.params as { slug?: string; type?: string };
    const typeParsed = destinationTypeSchema.safeParse(params.type);
    if (!typeParsed.success) {
      return reply.status(400).send({ error: "invalid_destination_type" });
    }
    const ws = await loadWorkspaceForUser(
        input.db,
        session.userId,
        readTeamIdHeader(request.headers),
        params.slug ?? "",
      );
    if (ws.kind === "invalid_team") {
      return reply.status(400).send({ error: "invalid_team" });
    }
    if (ws.kind === "not_a_member") {
      return reply.status(403).send({ error: "not_a_team_member" });
    }
    if (ws.kind === "invalid_slug") {
      return reply.status(400).send({ error: "invalid_slug" });
    }
    if (ws.kind === "not_found") {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    if (!canWriteWorkspaces(ws.role)) {
      return reply.status(403).send({ error: "insufficient_role" });
    }
    await input.db
      .delete(workspaceDestinationsTable)
      .where(
        and(
          eq(workspaceDestinationsTable.workspaceId, ws.id),
          eq(workspaceDestinationsTable.type, typeParsed.data),
        ),
      );
    return reply.status(204).send();
  });

  instance.get(
    "/api/me/workspaces/by-slug/:slug/destinations/notion/databases",
    async (request, reply) => {
      const session = requireSession(request);
      if (session === null) {
        return reply.status(401).send({ error: "invalid_session" });
      }
      const params = request.params as { slug?: string };
      const ws = await loadWorkspaceForUser(
        input.db,
        session.userId,
        readTeamIdHeader(request.headers),
        params.slug ?? "",
      );
      if (ws.kind === "invalid_team") {
        return reply.status(400).send({ error: "invalid_team" });
      }
      if (ws.kind === "not_a_member") {
        return reply.status(403).send({ error: "not_a_team_member" });
      }
      if (ws.kind === "invalid_slug") {
        return reply.status(400).send({ error: "invalid_slug" });
      }
      if (ws.kind === "not_found") {
        return reply.status(404).send({ error: "workspace_not_found" });
      }
      const rows = await input.db
        .select({ secretCiphertext: workspaceDestinationsTable.secretCiphertext })
        .from(workspaceDestinationsTable)
        .where(
          and(
            eq(workspaceDestinationsTable.workspaceId, ws.id),
            eq(workspaceDestinationsTable.type, "notion"),
          ),
        )
        .limit(1);
      const cipher = rows[0]?.secretCiphertext;
      if (!cipher) {
        return reply.status(400).send({ error: "notion_not_connected" });
      }
      let token: string;
      try {
        token = openSecret(cipher, input.jwtSecret);
      } catch {
        return reply.status(400).send({ error: "notion_not_connected" });
      }
      try {
        const databases = await listNotionDatabases(token);
        const suggestions = suggestNotionDatabaseRoles(databases);
        request.log.info(
          { workspaceId: ws.id, count: databases.length },
          "notion_databases_listed",
        );
        return reply.send({ databases, suggestions });
      } catch (err) {
        request.log.warn({ err }, "notion_list_databases_failed");
        return reply.status(502).send({ error: "notion_list_failed" });
      }
    },
  );
};
