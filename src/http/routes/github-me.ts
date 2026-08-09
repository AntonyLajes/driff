import { Octokit } from "@octokit/rest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  signGithubOAuthState,
  verifyGithubOAuthState,
} from "@/auth/github-oauth-state.js";
import { verifySessionJwt } from "@/auth/session-jwt.js";
import { sealSecret } from "@/auth/token-aes.js";
import type { Env } from "@/config/env.js";
import type { Database } from "@/db/client.js";
import { userSourceConnectionsTable } from "@/db/schema.js";

const GITHUB_PROVIDER = "github";
import { loadUserGithubAccessToken } from "@/github/load-user-github-access-token.js";
import { inferRepoKind } from "@/github/repo-kind-infer.js";

const GITHUB_OAUTH_SCOPES = "read:user repo";
const REQUIRED_GITHUB_SCOPES = GITHUB_OAUTH_SCOPES.split(" ");

const scopeList = (scope: string | null): string[] =>
  scope
    ?.split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean) ?? [];

const readBearerToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export interface GithubMeRegistrationInput {
  db: Database;
  jwtSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  publicApiUrl: string;
  frontendUrl: string;
  nodeEnv: string;
}

export const buildGithubMeRegistrationInput = (
  env: Env,
): Omit<GithubMeRegistrationInput, "db"> | undefined => {
  if (
    env.GITHUB_USER_OAUTH_CLIENT_ID === undefined ||
    env.GITHUB_USER_OAUTH_CLIENT_SECRET === undefined ||
    env.AUTH_JWT_SECRET === undefined ||
    env.AUTH_PUBLIC_URL === undefined ||
    env.FRONTEND_URL === undefined
  ) {
    return undefined;
  }
  return {
    jwtSecret: env.AUTH_JWT_SECRET,
    githubClientId: env.GITHUB_USER_OAUTH_CLIENT_ID,
    githubClientSecret: env.GITHUB_USER_OAUTH_CLIENT_SECRET,
    publicApiUrl: trimTrailingSlash(env.AUTH_PUBLIC_URL),
    frontendUrl: trimTrailingSlash(env.FRONTEND_URL),
    nodeEnv: env.NODE_ENV,
  };
};

const exchangeGithubOAuthCode = async (input: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<{
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
}> => {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`github_token_http_${response.status}:${text}`);
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (typeof json.access_token !== "string") {
    const err = json.error_description ?? json.error ?? "missing_access_token";
    throw new Error(`github_token_error:${err}`);
  }
  return {
    access_token: json.access_token,
    refresh_token:
      typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
    expires_in:
      typeof json.expires_in === "number" ? json.expires_in : undefined,
  };
};

const fetchGithubUserLogin = async (
  accessToken: string,
): Promise<{ id: string; login: string }> => {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`github_user_http_${response.status}:${text}`);
  }
  const json = (await response.json()) as { id?: number; login?: string };
  if (typeof json.id !== "number" || typeof json.login !== "string") {
    throw new Error("github_user_missing_fields");
  }
  return { id: String(json.id), login: json.login };
};

export const handler = async (
  instance: FastifyInstance,
  input: GithubMeRegistrationInput,
): Promise<void> => {
  const redirectUri = `${input.publicApiUrl}/api/me/github/oauth/callback`;

  instance.post("/api/me/github/oauth/start", async (request, reply) => {
    const bearer = readBearerToken(request.headers.authorization);
    if (bearer === null) {
      return reply
        .status(401)
        .send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(bearer, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const state = signGithubOAuthState({
      userId: session.userId,
      secret: input.jwtSecret,
    });
    const params = new URLSearchParams({
      client_id: input.githubClientId,
      redirect_uri: redirectUri,
      scope: GITHUB_OAUTH_SCOPES,
      state,
    });
    const authorizeUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    return reply.send({ authorizeUrl });
  });

  instance.get("/api/me/github/oauth/callback", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const code = query.code;
    const state = query.state;
    const frontend = input.frontendUrl;

    const redirectWith = (search: Record<string, string>) => {
      const qs = new URLSearchParams(search).toString();
      return reply.redirect(`${frontend}/workspaces/new/github?${qs}`, 302);
    };

    if (typeof code !== "string" || typeof state !== "string") {
      return redirectWith({ github_oauth: "missing_code_or_state" });
    }

    const verified = verifyGithubOAuthState(state, input.jwtSecret);
    if (verified === null) {
      return redirectWith({ github_oauth: "invalid_state" });
    }

    try {
      const tokenBundle = await exchangeGithubOAuthCode({
        code,
        redirectUri,
        clientId: input.githubClientId,
        clientSecret: input.githubClientSecret,
      });
      const ghUser = await fetchGithubUserLogin(tokenBundle.access_token);
      const now = new Date();
      const expiresAt =
        typeof tokenBundle.expires_in === "number"
          ? new Date(now.getTime() + tokenBundle.expires_in * 1000)
          : null;

      const accessCipher = sealSecret(
        tokenBundle.access_token,
        input.jwtSecret,
      );
      const refreshCipher =
        tokenBundle.refresh_token !== undefined
          ? sealSecret(tokenBundle.refresh_token, input.jwtSecret)
          : null;

      await input.db
        .insert(userSourceConnectionsTable)
        .values({
          userId: verified.userId,
          provider: GITHUB_PROVIDER,
          accessTokenCiphertext: accessCipher,
          refreshTokenCiphertext: refreshCipher,
          scope: tokenBundle.scope ?? null,
          tokenExpiresAt: expiresAt,
          externalAccountId: ghUser.id,
          externalLogin: ghUser.login,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            userSourceConnectionsTable.userId,
            userSourceConnectionsTable.provider,
          ],
          set: {
            accessTokenCiphertext: accessCipher,
            refreshTokenCiphertext: refreshCipher,
            scope: tokenBundle.scope ?? null,
            tokenExpiresAt: expiresAt,
            externalAccountId: ghUser.id,
            externalLogin: ghUser.login,
            updatedAt: now,
          },
        });

      return redirectWith({
        github_oauth: "success",
        github_login: ghUser.login,
      });
    } catch (err) {
      request.log.warn({ err }, "github_oauth_callback_failed");
      return redirectWith({ github_oauth: "exchange_failed" });
    }
  });

  instance.get("/api/me/github/status", async (request, reply) => {
    const bearer = readBearerToken(request.headers.authorization);
    if (bearer === null) {
      return reply
        .status(401)
        .send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(bearer, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const rows = await input.db
      .select({
        externalLogin: userSourceConnectionsTable.externalLogin,
        scope: userSourceConnectionsTable.scope,
        tokenExpiresAt: userSourceConnectionsTable.tokenExpiresAt,
      })
      .from(userSourceConnectionsTable)
      .where(
        and(
          eq(userSourceConnectionsTable.userId, session.userId),
          eq(userSourceConnectionsTable.provider, GITHUB_PROVIDER),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return reply.send({ connected: false, connectionState: "disconnected" });
    }
    const grantedScopes = scopeList(row.scope ?? null);
    const missingScopes =
      row.scope === null || row.scope === undefined
        ? []
        : REQUIRED_GITHUB_SCOPES.filter(
            (scope) => !grantedScopes.includes(scope),
          );
    if (
      row.tokenExpiresAt instanceof Date &&
      row.tokenExpiresAt.getTime() <= Date.now()
    ) {
      return reply.send({
        connected: false,
        connectionState: "expired",
        githubLogin: row.externalLogin ?? undefined,
        missingScopes,
      });
    }
    if (missingScopes.length > 0) {
      return reply.send({
        connected: false,
        connectionState: "permissions",
        githubLogin: row.externalLogin ?? undefined,
        missingScopes,
      });
    }

    const accessToken = await loadUserGithubAccessToken(
      input.db,
      session.userId,
      input.jwtSecret,
    );
    if (accessToken === null) {
      return reply.send({
        connected: false,
        connectionState: "revoked",
        githubLogin: row.externalLogin ?? undefined,
        missingScopes,
      });
    }
    if (typeof accessToken === "string") {
      try {
        const octokit = new Octokit({ auth: accessToken });
        await octokit.rest.users.getAuthenticated();
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 401
        ) {
          return reply.send({
            connected: false,
            connectionState: "revoked",
            githubLogin: row.externalLogin ?? undefined,
            missingScopes,
          });
        }
        request.log.warn({ error }, "github_status_validation_failed");
      }
    }
    return reply.send({
      connected: true,
      connectionState: "active",
      githubLogin: row.externalLogin ?? undefined,
      missingScopes,
    });
  });

  instance.delete("/api/me/github/disconnect", async (request, reply) => {
    const bearer = readBearerToken(request.headers.authorization);
    if (bearer === null) {
      return reply
        .status(401)
        .send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(bearer, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    await input.db
      .delete(userSourceConnectionsTable)
      .where(
        and(
          eq(userSourceConnectionsTable.userId, session.userId),
          eq(userSourceConnectionsTable.provider, GITHUB_PROVIDER),
        ),
      );
    return reply.status(204).send();
  });

  const reposQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    per_page: z.coerce.number().int().min(1).max(100).default(30),
  });

  instance.get("/api/me/github/repos", async (request, reply) => {
    const bearer = readBearerToken(request.headers.authorization);
    if (bearer === null) {
      return reply
        .status(401)
        .send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(bearer, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const accessToken = await loadUserGithubAccessToken(
      input.db,
      session.userId,
      input.jwtSecret,
    );
    if (accessToken === null) {
      return reply.status(400).send({ error: "github_not_connected" });
    }
    const parsed = reposQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_query" });
    }
    const { page, per_page: perPage } = parsed.data;
    const octokit = new Octokit({ auth: accessToken });
    const { data } = await octokit.rest.repos.listForAuthenticatedUser({
      per_page: perPage,
      page,
      sort: "pushed",
      affiliation: "owner,collaborator,organization_member",
    });
    const repos = data.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      description: r.description ?? null,
      pushedAt: r.pushed_at ?? null,
    }));
    return reply.send({
      repos,
      page,
      perPage,
      hasMore: repos.length === perPage,
    });
  });

  const inferBodySchema = z.object({
    fullName: z
      .string()
      .min(3)
      .max(241)
      .regex(/^[\w.-]+\/[\w.-]+$/u, "expected owner/repo"),
  });

  instance.post("/api/me/github/repo/infer", async (request, reply) => {
    const bearer = readBearerToken(request.headers.authorization);
    if (bearer === null) {
      return reply
        .status(401)
        .send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(bearer, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const accessToken = await loadUserGithubAccessToken(
      input.db,
      session.userId,
      input.jwtSecret,
    );
    if (accessToken === null) {
      return reply.status(400).send({ error: "github_not_connected" });
    }
    const parsed = inferBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body" });
    }
    const octokit = new Octokit({ auth: accessToken });
    try {
      const inference = await inferRepoKind(octokit, parsed.data.fullName);
      return reply.send({ inference });
    } catch (err) {
      request.log.warn({ err }, "github_repo_infer_failed");
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

  const repoBranchesQuerySchema = z.object({
    fullName: z
      .string()
      .min(3)
      .max(241)
      .regex(/^[\w.-]+\/[\w.-]+$/u, "expected owner/repo"),
  });

  /** List a repo's branch names — feeds the wizard's branch pickers. */
  instance.get("/api/me/github/repo/branches", async (request, reply) => {
    const bearer = readBearerToken(request.headers.authorization);
    if (bearer === null) {
      return reply
        .status(401)
        .send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(bearer, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }
    const accessToken = await loadUserGithubAccessToken(
      input.db,
      session.userId,
      input.jwtSecret,
    );
    if (accessToken === null) {
      return reply.status(400).send({ error: "github_not_connected" });
    }
    const parsedQuery = repoBranchesQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.status(400).send({ error: "invalid_query" });
    }
    const repoFull = parsedQuery.data.fullName.trim();
    const slash = repoFull.indexOf("/");
    if (slash <= 0 || slash === repoFull.length - 1) {
      return reply.status(400).send({ error: "invalid_repo_full_name" });
    }
    const owner = repoFull.slice(0, slash);
    const repo = repoFull.slice(slash + 1);

    const octokit = new Octokit({ auth: accessToken });
    try {
      /* The repo's true default branch — never assume "main". */
      const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });

      const branches: string[] = [];
      const PER_PAGE = 100;
      const MAX_PAGES = 5; // safety cap: 500 branches
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { data } = await octokit.rest.repos.listBranches({
          owner,
          repo,
          per_page: PER_PAGE,
          page,
        });
        branches.push(...data.map((branch) => branch.name));
        if (data.length < PER_PAGE) {
          break;
        }
      }

      return reply.send({
        branches,
        defaultBranch: repoInfo.default_branch,
      });
    } catch (err) {
      request.log.warn({ err }, "github_repo_branches_failed");
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? Number((err as { status?: unknown }).status)
          : NaN;
      if (status === 404) {
        return reply.status(404).send({ error: "repo_not_found_or_no_access" });
      }
      return reply.status(500).send({ error: "branches_failed" });
    }
  });

  const repoContentsQuerySchema = z.object({
    fullName: z
      .string()
      .min(3)
      .max(241)
      .regex(/^[\w.-]+\/[\w.-]+$/u, "expected owner/repo"),
    path: z.string().max(1024).default(""),
    ref: z.string().max(255).optional(),
  });

  /**
   * Browse an arbitrary accessible repo before a workspace exists — used by
   * the new-project wizard's version-file picker. Mirrors the workspace-scoped
   * `/repo/contents` endpoint.
   */
  instance.get("/api/me/github/repo/contents", async (request, reply) => {
    const bearer = readBearerToken(request.headers.authorization);
    if (bearer === null) {
      return reply
        .status(401)
        .send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(bearer, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
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
    const repoFull = parsedQuery.data.fullName.trim();
    const pathParam = parsedQuery.data.path.trim();
    const refParam = parsedQuery.data.ref?.trim() || "";

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
        ...(refParam.length > 0 ? { ref: refParam } : {}),
      });
      if (!Array.isArray(data)) {
        const name =
          "name" in data && typeof data.name === "string" ? data.name : "";
        const path =
          "path" in data && typeof data.path === "string"
            ? data.path
            : pathParam;
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
    } catch (err) {
      request.log.warn({ err }, "github_repo_contents_failed");
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? Number((err as { status?: unknown }).status)
          : NaN;
      if (status === 404) {
        return reply.status(404).send({ error: "repo_or_path_not_found" });
      }
      return reply.status(500).send({ error: "contents_failed" });
    }
  });
};
