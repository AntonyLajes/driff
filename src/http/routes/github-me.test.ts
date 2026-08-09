import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signGithubOAuthState } from "@/auth/github-oauth-state.js";
import { signSessionJwt } from "@/auth/session-jwt.js";

const octokitMocks = vi.hoisted(() => ({
  listForAuthenticatedUser: vi.fn(),
  get: vi.fn(),
  listBranches: vi.fn(),
  getContent: vi.fn(),
  getAuthenticated: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = {
      repos: {
        listForAuthenticatedUser: octokitMocks.listForAuthenticatedUser,
        get: octokitMocks.get,
        listBranches: octokitMocks.listBranches,
        getContent: octokitMocks.getContent,
      },
      users: { getAuthenticated: octokitMocks.getAuthenticated },
    };
  },
}));

vi.mock("@/github/load-user-github-access-token.js", () => ({
  loadUserGithubAccessToken: vi.fn(),
}));
vi.mock("@/github/repo-kind-infer.js", () => ({ inferRepoKind: vi.fn() }));

import { loadUserGithubAccessToken } from "@/github/load-user-github-access-token.js";
import { inferRepoKind } from "@/github/repo-kind-infer.js";
import {
  buildGithubMeRegistrationInput,
  handler,
} from "@/http/routes/github-me.js";

describe("http/routes/github-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];
  const jwtSecret = "g".repeat(40);
  const userId = "00000000-0000-4000-8000-000000000099";
  const token = signSessionJwt({
    secret: jwtSecret,
    userId,
    email: "user@example.com",
    expiresInSeconds: 3600,
  });
  const authorization = { authorization: `Bearer ${token}` };

  const register = async (db: unknown = {}) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: db as never,
      jwtSecret,
      githubClientId: "client-id",
      githubClientSecret: "client-secret",
      publicApiUrl: "https://api.driff.dev",
      frontendUrl: "https://driff.dev",
      nodeEnv: "test",
    });
    await server.ready();
    return server;
  };

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
    vi.restoreAllMocks();
    vi.mocked(loadUserGithubAccessToken).mockReset();
    vi.mocked(inferRepoKind).mockReset();
    for (const mock of Object.values(octokitMocks)) {
      mock.mockReset();
    }
  });

  it("only enables registration when every OAuth setting is available", () => {
    const complete = {
      GITHUB_USER_OAUTH_CLIENT_ID: "id",
      GITHUB_USER_OAUTH_CLIENT_SECRET: "secret",
      AUTH_JWT_SECRET: jwtSecret,
      AUTH_PUBLIC_URL: "https://api.driff.dev",
      FRONTEND_URL: "https://driff.dev",
      NODE_ENV: "production",
    };
    for (const missing of [
      "GITHUB_USER_OAUTH_CLIENT_ID",
      "GITHUB_USER_OAUTH_CLIENT_SECRET",
      "AUTH_JWT_SECRET",
      "AUTH_PUBLIC_URL",
      "FRONTEND_URL",
    ] as const) {
      const env = { ...complete };
      delete env[missing];
      expect(buildGithubMeRegistrationInput(env as never)).toBeUndefined();
    }

    expect(
      buildGithubMeRegistrationInput({
        GITHUB_USER_OAUTH_CLIENT_ID: "id",
        GITHUB_USER_OAUTH_CLIENT_SECRET: "secret",
        AUTH_JWT_SECRET: jwtSecret,
        AUTH_PUBLIC_URL: "https://api.driff.dev///",
        FRONTEND_URL: "https://driff.dev/",
        NODE_ENV: "production",
      } as never),
    ).toEqual({
      jwtSecret,
      githubClientId: "id",
      githubClientSecret: "secret",
      publicApiUrl: "https://api.driff.dev",
      frontendUrl: "https://driff.dev",
      nodeEnv: "production",
    });
  });

  it("starts OAuth only for an authenticated user", async () => {
    const server = await register();
    const missing = await server.inject({
      method: "POST",
      url: "/api/me/github/oauth/start",
    });
    const invalid = await server.inject({
      method: "POST",
      url: "/api/me/github/oauth/start",
      headers: { authorization: "Bearer invalid" },
    });
    const success = await server.inject({
      method: "POST",
      url: "/api/me/github/oauth/start",
      headers: authorization,
    });

    expect(missing.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ error: "invalid_session" });
    const authorizeUrl = new URL(
      success.json<{ authorizeUrl: string }>().authorizeUrl,
    );
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizeUrl.searchParams.get("scope")).toBe("read:user repo");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.driff.dev/api/me/github/oauth/callback",
    );
    expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
  });

  const protectedGithubRoutes = [
    ["POST", "/api/me/github/oauth/start"],
    ["GET", "/api/me/github/status"],
    ["DELETE", "/api/me/github/disconnect"],
    ["GET", "/api/me/github/repos"],
    ["POST", "/api/me/github/repo/infer"],
    ["GET", "/api/me/github/repo/branches?repo=owner/repo"],
    ["GET", "/api/me/github/repo/contents?repo=owner/repo"],
  ] as const;

  it.each(protectedGithubRoutes)(
    "protects %s %s without authorization",
    async (method, url) => {
      const server = await register();
      const response = await server.inject({
        method,
        url,
        payload:
          method === "POST" && url.endsWith("infer")
            ? { repoFullName: "owner/repo" }
            : undefined,
      });
      expect(response.statusCode).toBe(401);
    },
  );

  it.each(protectedGithubRoutes)(
    "rejects an invalid JWT for %s %s",
    async (method, url) => {
      const server = await register();
      const response = await server.inject({
        method,
        url,
        headers: { authorization: "Bearer invalid" },
        payload:
          method === "POST" && url.endsWith("infer")
            ? { repoFullName: "owner/repo" }
            : undefined,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid_session" });
    },
  );

  it("handles missing and invalid OAuth callback parameters", async () => {
    const server = await register();
    const missing = await server.inject({
      method: "GET",
      url: "/api/me/github/oauth/callback",
    });
    const invalid = await server.inject({
      method: "GET",
      url: "/api/me/github/oauth/callback?code=abc&state=invalid",
    });

    expect(missing.statusCode).toBe(302);
    expect(missing.headers.location).toBe(
      "https://driff.dev/workspaces/new/github?github_oauth=missing_code_or_state",
    );
    expect(invalid.headers.location).toBe(
      "https://driff.dev/workspaces/new/github?github_oauth=invalid_state",
    );
  });

  it("persists a successful OAuth exchange and redirects to onboarding", async () => {
    const onConflictDoUpdate = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const server = await register({ insert: vi.fn(() => ({ values })) });
    const state = signGithubOAuthState({ userId, secret: jwtSecret });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            scope: "repo",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42, login: "octocat" }), {
          status: 200,
        }),
      );

    const response = await server.inject({
      method: "GET",
      url: `/api/me/github/oauth/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      "https://driff.dev/workspaces/new/github?github_oauth=success&github_login=octocat",
    );
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        provider: "github",
        externalAccountId: "42",
        externalLogin: "octocat",
        scope: "repo",
        refreshTokenCiphertext: expect.any(String),
        tokenExpiresAt: expect.any(Date),
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("turns OAuth provider failures into a safe redirect", async () => {
    const server = await register();
    const state = signGithubOAuthState({ userId, secret: jwtSecret });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("provider unavailable", { status: 502 }),
    );

    const response = await server.inject({
      method: "GET",
      url: `/api/me/github/oauth/callback?code=bad&state=${encodeURIComponent(state)}`,
    });

    expect(response.headers.location).toBe(
      "https://driff.dev/workspaces/new/github?github_oauth=exchange_failed",
    );
  });

  it("returns connection status and disconnects the current user", async () => {
    const rows = [[{ externalLogin: "octocat" }], []];
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => rows.shift() ?? []) })),
      })),
    }));
    const whereDelete = vi.fn(async () => undefined);
    const deleteFn = vi.fn(() => ({ where: whereDelete }));
    const server = await register({ select, delete: deleteFn });

    const connected = await server.inject({
      method: "GET",
      url: "/api/me/github/status",
      headers: authorization,
    });
    const disconnected = await server.inject({
      method: "GET",
      url: "/api/me/github/status",
      headers: authorization,
    });
    const removed = await server.inject({
      method: "DELETE",
      url: "/api/me/github/disconnect",
      headers: authorization,
    });

    expect(connected.json()).toEqual({
      connected: true,
      connectionState: "active",
      githubLogin: "octocat",
      missingScopes: [],
    });
    expect(disconnected.json()).toEqual({
      connected: false,
      connectionState: "disconnected",
    });
    expect(removed.statusCode).toBe(204);
    expect(whereDelete).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "expired",
      row: {
        externalLogin: "octocat",
        scope: "read:user repo",
        tokenExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
      },
      expected: { connectionState: "expired", missingScopes: [] },
    },
    {
      name: "missing permissions",
      row: {
        externalLogin: "octocat",
        scope: "read:user",
        tokenExpiresAt: null,
      },
      expected: { connectionState: "permissions", missingScopes: ["repo"] },
    },
  ])(
    "reports a $name connection that needs reauthorization",
    async ({ row, expected }) => {
      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [row]) })),
        })),
      }));
      const server = await register({ select });

      const response = await server.inject({
        method: "GET",
        url: "/api/me/github/status",
        headers: authorization,
      });

      expect(response.json()).toMatchObject({
        connected: false,
        githubLogin: "octocat",
        ...expected,
      });
    },
  );

  it("reports a provider-revoked token", async () => {
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            {
              externalLogin: "octocat",
              scope: "read:user repo",
              tokenExpiresAt: null,
            },
          ]),
        })),
      })),
    }));
    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("revoked-token");
    octokitMocks.getAuthenticated.mockRejectedValue({ status: 401 });
    const server = await register({ select });

    const response = await server.inject({
      method: "GET",
      url: "/api/me/github/status",
      headers: authorization,
    });

    expect(response.json()).toMatchObject({
      connected: false,
      connectionState: "revoked",
      githubLogin: "octocat",
    });
  });

  it("lists normalized repositories with pagination metadata", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("token");
    octokitMocks.listForAuthenticatedUser.mockResolvedValue({
      data: [
        {
          id: 1,
          name: "app",
          full_name: "acme/app",
          private: true,
          default_branch: "trunk",
          description: undefined,
          pushed_at: undefined,
        },
      ],
    });
    const server = await register();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/github/repos?page=2&per_page=1",
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      repos: [
        {
          id: 1,
          name: "app",
          fullName: "acme/app",
          private: true,
          defaultBranch: "trunk",
          description: null,
          pushedAt: null,
        },
      ],
      page: 2,
      perPage: 1,
      hasMore: true,
    });
  });

  it("guards repository listing inputs and missing connections", async () => {
    vi.mocked(loadUserGithubAccessToken)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("token");
    const server = await register();

    const noConnection = await server.inject({
      method: "GET",
      url: "/api/me/github/repos",
      headers: authorization,
    });
    const invalidQuery = await server.inject({
      method: "GET",
      url: "/api/me/github/repos?per_page=101",
      headers: authorization,
    });

    expect(noConnection.json()).toEqual({ error: "github_not_connected" });
    expect(invalidQuery.json()).toEqual({ error: "invalid_query" });
  });

  it("infers a repository and maps provider errors", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("token");
    vi.mocked(inferRepoKind)
      .mockResolvedValueOnce({
        suggestedKind: "react_native_expo",
        confidence: "high",
        defaultBranch: "main",
        versionFilePath: "app.json",
        signals: ["dependency:expo"],
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), { status: 404 }),
      )
      .mockRejectedValueOnce(new Error("network"));
    const server = await register();
    const request = () =>
      server.inject({
        method: "POST",
        url: "/api/me/github/repo/infer",
        headers: authorization,
        payload: { fullName: "acme/app" },
      });

    expect((await request()).json()).toMatchObject({
      inference: { suggestedKind: "react_native_expo" },
    });
    expect((await request()).json()).toEqual({
      error: "repo_not_found_or_no_access",
    });
    expect((await request()).json()).toEqual({ error: "infer_failed" });
    const invalid = await server.inject({
      method: "POST",
      url: "/api/me/github/repo/infer",
      headers: authorization,
      payload: { fullName: "invalid" },
    });
    expect(invalid.json()).toEqual({ error: "invalid_body" });
  });

  it("lists branches across pages and returns the real default branch", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("token");
    octokitMocks.get.mockResolvedValue({ data: { default_branch: "develop" } });
    octokitMocks.listBranches
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) => ({
          name: `branch-${index}`,
        })),
      })
      .mockResolvedValueOnce({ data: [{ name: "last" }] });
    const server = await register();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/github/repo/branches?fullName=acme%2Fapp",
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ branches: string[]; defaultBranch: string }>(),
    ).toMatchObject({
      defaultBranch: "develop",
    });
    expect(response.json<{ branches: string[] }>().branches).toHaveLength(101);
    expect(octokitMocks.listBranches).toHaveBeenCalledTimes(2);
  });

  it("validates branch queries and translates GitHub failures", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("token");
    octokitMocks.get
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), { status: 404 }),
      )
      .mockRejectedValueOnce(new Error("network"));
    const server = await register();

    const invalid = await server.inject({
      method: "GET",
      url: "/api/me/github/repo/branches?fullName=invalid",
      headers: authorization,
    });
    const missing = await server.inject({
      method: "GET",
      url: "/api/me/github/repo/branches?fullName=acme%2Fapp",
      headers: authorization,
    });
    const failed = await server.inject({
      method: "GET",
      url: "/api/me/github/repo/branches?fullName=acme%2Fapp",
      headers: authorization,
    });

    expect(invalid.json()).toEqual({ error: "invalid_query" });
    expect(missing.json()).toEqual({ error: "repo_not_found_or_no_access" });
    expect(failed.json()).toEqual({ error: "branches_failed" });
  });

  it("browses repository contents with stable directory-first ordering", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("token");
    octokitMocks.getContent.mockResolvedValue({
      data: [
        { type: "file", name: "z.ts", path: "src/z.ts" },
        { type: "symlink", name: "ignored", path: "src/ignored" },
        { type: "dir", name: "components", path: "src/components" },
        { type: "file", name: "a.ts", path: "src/a.ts" },
      ],
    });
    const server = await register();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/github/repo/contents?fullName=acme%2Fapp&path=src&ref=develop",
      headers: authorization,
    });

    expect(response.json()).toEqual({
      ref: "develop",
      requestedPath: "src",
      entries: [
        { name: "components", path: "src/components", type: "dir" },
        { name: "a.ts", path: "src/a.ts", type: "file" },
        { name: "z.ts", path: "src/z.ts", type: "file" },
      ],
    });
    expect(octokitMocks.getContent).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
      path: "src",
      ref: "develop",
    });
  });

  it("supports a file response and translates content failures", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("token");
    octokitMocks.getContent
      .mockResolvedValueOnce({
        data: { type: "file", name: "app.json", path: "app.json" },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), { status: 404 }),
      )
      .mockRejectedValueOnce(new Error("network"));
    const server = await register();
    const request = () =>
      server.inject({
        method: "GET",
        url: "/api/me/github/repo/contents?fullName=acme%2Fapp&path=app.json",
        headers: authorization,
      });

    expect((await request()).json()).toEqual({
      ref: "",
      requestedPath: "app.json",
      entries: [{ name: "app.json", path: "app.json", type: "file" }],
    });
    expect((await request()).json()).toEqual({
      error: "repo_or_path_not_found",
    });
    expect((await request()).json()).toEqual({ error: "contents_failed" });
  });
});
