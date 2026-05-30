import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/workspaces-me.js";

vi.mock("@/workspaces/infer-workspace-settings.js", () => ({
  inferAndApplyWorkspaceSettings: vi.fn(),
}));

vi.mock("@/github/load-user-github-access-token.js", () => ({
  loadUserGithubAccessToken: vi.fn(),
}));

import { loadUserGithubAccessToken } from "@/github/load-user-github-access-token.js";
import { inferAndApplyWorkspaceSettings } from "@/workspaces/infer-workspace-settings.js";

describe("http/routes/workspaces-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
    vi.mocked(inferAndApplyWorkspaceSettings).mockReset();
    vi.mocked(loadUserGithubAccessToken).mockReset();
  });

  const jwtSecret = "a".repeat(32);

  it("returns 401 when Authorization is missing", async () => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();

    const response = await server.inject({ method: "GET", url: "/api/me/workspaces" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "missing_or_invalid_authorization" });
  });

  it("returns 401 when the session JWT is invalid", async () => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces",
      headers: { authorization: "Bearer not-a-jwt" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "invalid_session" });
  });

  it("returns workspaces from the database for a valid session", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const orderBy = vi.fn(async () => []);
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ workspaces: [] });
    expect(select).toHaveBeenCalledOnce();
  });

  it("returns 201 after creating a workspace linked to a repo", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const updatedAt = new Date("2026-01-01T00:00:00.000Z");
    const createdRow = {
      id: "00000000-0000-4000-8000-0000000000aa",
      name: "acme-app",
      slug: "acme-app",
      sourceProvider: "github",
      workspaceKind: "ios_plist" as string | null,
      repoFullName: "acme/acme-app",
      repoDefaultBranch: "main",
      createdAt,
      updatedAt,
    };

    const returning = vi.fn(async () => [createdRow]);
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        sourceProvider: "github",
        repoFullName: "acme/acme-app",
        repoDefaultBranch: "main",
        workspaceKind: "ios_plist",
      },
    });

    expect(response.statusCode).toBe(201);
    const json = response.json() as { workspace: typeof createdRow };
    expect(json.workspace.id).toBe(createdRow.id);
    expect(json.workspace.slug).toBe("acme-app");
    expect(json.workspace.repoFullName).toBe("acme/acme-app");
    expect(json.workspace.sourceProvider).toBe("github");
    // slug derived from the repo name part
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "acme-app", repoFullName: "acme/acme-app" }),
    );
  });

  it("defaults the provider to github when omitted", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const returning = vi.fn(async () => [
      { id: "x", name: "r", slug: "r", sourceProvider: "github", workspaceKind: null, repoFullName: "o/r", repoDefaultBranch: null, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { repoFullName: "o/r" },
    });

    expect(response.statusCode).toBe(201);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ sourceProvider: "github" }));
  });

  it("returns 400 when no repo is provided", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const insert = vi.fn();
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "No Repo" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_body" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns 400 for a provider without a runtime implementation", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const insert = vi.fn();
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceProvider: "gitlab", repoFullName: "group/app" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "unsupported_provider" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns 409 repo_already_linked when the repo is taken", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const returning = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("duplicate"), {
          code: "23505",
          constraint_name: "workspaces_provider_repo_unique",
        }),
      ),
    );
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { repoFullName: "acme/dup" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "repo_already_linked" });
  });

  it("retries with a suffixed slug on a slug collision", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const createdRow = {
      id: "00000000-0000-4000-8000-0000000000ad",
      name: "app",
      slug: "app-2",
      sourceProvider: "github",
      workspaceKind: null as string | null,
      repoFullName: "other/app",
      repoDefaultBranch: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const returning = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error("dup slug"), {
            code: "23505",
            constraint_name: "workspaces_user_id_slug_unique",
          }),
        ),
      )
      .mockImplementationOnce(async () => [createdRow]);
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { repoFullName: "other/app" },
    });

    expect(response.statusCode).toBe(201);
    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({ slug: "app" }));
    expect(values).toHaveBeenNthCalledWith(2, expect.objectContaining({ slug: "app-2" }));
  });

  it("returns diagnostics with warning when releases config is missing", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const workspaceRow = {
      id: "00000000-0000-4000-8000-0000000000ab",
      name: "Acme",
      slug: "acme",
      workspaceKind: "react_native_expo" as string | null,
      repoFullName: "acme/mobile",
      repoDefaultBranch: "main",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const settingsRow = {
      notionPrDatabaseId: "notion-pr-db",
      notionReleasesDatabaseId: null,
      releaseProjectKind: "react_native_expo",
      releaseVersionFilePath: "app.json",
      releaseVersionBranch: "main",
    };

    const select = vi
      .fn()
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [workspaceRow]) })),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [settingsRow]) })),
        })),
      }));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/acme/diagnostics",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      diagnostics: {
        repo: "acme/mobile",
        status: "warning",
        checks: {
          repoLinked: true,
          workspaceSettingsPresent: true,
          prSummaryReady: true,
          releaseSummaryReady: false,
        },
        suggested: {
          prBaseBranches: ["main"],
          releaseBranch: "main",
        },
      },
    });
  });

  it("applies inferred settings and returns diagnostics", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const workspaceRow = {
      id: "00000000-0000-4000-8000-0000000000ac",
      name: "Ride",
      slug: "ride-pack",
      workspaceKind: null as string | null,
      repoFullName: "acme/ride-pack",
      repoDefaultBranch: "main",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const settingsRow = {
      notionPrDatabaseId: "pr-db",
      notionReleasesDatabaseId: null,
      releaseProjectKind: "react_native_expo",
      releaseVersionFilePath: "app.json",
      releaseVersionBranch: "main",
    };

    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("gh-token");
    vi.mocked(inferAndApplyWorkspaceSettings).mockResolvedValue({
      inference: {
        suggestedKind: "react_native_expo",
        confidence: "high",
        defaultBranch: "main",
        versionFilePath: "app.json",
        signals: [],
      },
      applied: true,
      skipReason: null,
      settings: {
        notionPrDatabaseId: null,
        notionReleasesDatabaseId: null,
        releaseProjectKind: "react_native_expo",
        releaseVersionFilePath: "app.json",
        releaseVersionBranch: "main",
      },
      workspaceDefaultBranchUpdated: false,
      workspaceKindUpdated: true,
    });

    const select = vi
      .fn()
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [workspaceRow]) })),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [settingsRow]) })),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [
              {
                repoFullName: "acme/ride-pack",
                repoDefaultBranch: "main",
              },
            ]),
          })),
        })),
      }));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/settings/infer",
      headers: { authorization: `Bearer ${token}` },
      payload: { apply: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      applied: true,
      skipReason: null,
      settings: {
        releaseProjectKind: "react_native_expo",
        releaseVersionFilePath: "app.json",
      },
      diagnostics: {
        checks: {
          repoLinked: true,
          prSummaryReady: true,
        },
      },
    });
    expect(inferAndApplyWorkspaceSettings).toHaveBeenCalledOnce();
  });

  it("returns 404 diagnostics when workspace slug is not found", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
      })),
    }));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/missing/diagnostics",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "workspace_not_found" });
  });
});
