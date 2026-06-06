import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/workspaces-me.js";

vi.mock("@/workspaces/infer-workspace-settings.js", () => ({
  inferAndApplyWorkspaceSettings: vi.fn(),
}));

/* Sample-summary enqueue (Fase 3d) looks up the latest merged PR via Octokit. */
const { pullsListMock } = vi.hoisted(() => ({ pullsListMock: vi.fn() }));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = { pulls: { list: pullsListMock } };
  },
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
    pullsListMock.mockReset();
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
            constraint_name: "workspaces_team_id_slug_unique",
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

  it("returns error diagnostics when no destination is connected", async () => {
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
      releaseProjectKind: "react_native_expo",
      releaseVersionFilePath: "app.json",
      releaseVersionBranch: "main",
      pushSummaryBranches: null,
    };

    const select = vi
      .fn()
      // workspace-by-slug lookup
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [workspaceRow]) })),
        })),
      }))
      // workspace_settings
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [settingsRow]) })),
        })),
      }))
      // hasEnabledDestination -> none
      .mockImplementationOnce(() => ({
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
      url: "/api/me/workspaces/by-slug/acme/diagnostics",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      diagnostics: {
        repo: "acme/mobile",
        status: "error",
        checks: {
          repoLinked: true,
          destinationConnected: false,
          prSummaryReady: false,
          releaseSummaryReady: false,
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
      releaseProjectKind: "react_native_expo",
      releaseVersionFilePath: "app.json",
      releaseVersionBranch: "main",
      pushSummaryBranches: null,
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
        releaseProjectKind: "react_native_expo",
        releaseVersionFilePath: "app.json",
        releaseVersionBranch: "main",
      },
      workspaceDefaultBranchUpdated: false,
      workspaceKindUpdated: true,
    });

    const select = vi
      .fn()
      // workspace-by-slug lookup
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [workspaceRow]) })),
        })),
      }))
      // workspace_settings after infer
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [settingsRow]) })),
        })),
      }))
      // workspace row (repo/branch)
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [
              { repoFullName: "acme/ride-pack", repoDefaultBranch: "main" },
            ]),
          })),
        })),
      }))
      // hasEnabledDestination -> connected
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: "dest-1" }]) })),
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

  it("deletes a workspace and its repo summary history", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const workspaceId = "00000000-0000-4000-8000-0000000000ae";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    // ownership lookup -> returns the linked repo
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ repoFullName: "AntonyLajes/ride-pack" }]),
        })),
      })),
    }));
    const deleteWhere = vi.fn(async () => undefined);
    const deleteFn = vi.fn(() => ({ where: deleteWhere }));
    const db = { select, delete: deleteFn } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "DELETE",
      url: `/api/me/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(204);
    // 3 summary-table deletes + the workspace delete
    expect(deleteFn).toHaveBeenCalledTimes(4);
  });

  it("returns 404 when deleting a workspace the user does not own", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const workspaceId = "00000000-0000-4000-8000-0000000000af";
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
    const deleteFn = vi.fn();
    const db = { select, delete: deleteFn } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "DELETE",
      url: `/api/me/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "workspace_not_found" });
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("returns 400 when deleting with an invalid workspace id", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const token = signSessionJwt({
      secret: jwtSecret,
      userId,
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

    const db = { select: vi.fn(), delete: vi.fn() } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "DELETE",
      url: "/api/me/workspaces/not-a-uuid",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_workspace_id" });
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

  /* ------------------------------------------------------------------ */
  /* Unified summaries feed + detail (Fase 3b)                           */
  /* ------------------------------------------------------------------ */

  const feedToken = () =>
    signSessionJwt({
      secret: jwtSecret,
      userId: "00000000-0000-4000-8000-000000000099",
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

  const feedWorkspaceRow = {
    id: "00000000-0000-4000-8000-0000000000aa",
    name: "ride-pack",
    slug: "ride-pack",
    sourceProvider: "github",
    workspaceKind: "react_native_expo",
    repoFullName: "AntonyLajes/ride-pack",
    repoDefaultBranch: "main",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  /** select().from().where().limit() — workspace-by-slug lookup. */
  const lookupSelect = (rows: unknown[]) => () => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
    })),
  });
  /** select().from().where().orderBy().limit() — feed page query. */
  const feedSelect = (rows: unknown[]) => () => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
      })),
    })),
  });
  /** select({count}).from().where() — awaited directly. */
  const countSelect = (value: number) => () => ({
    from: vi.fn(() => ({ where: vi.fn(async () => [{ value }]) })),
  });
  /** select().from().where().limit() — detail row lookup. */
  const detailSelect = lookupSelect;

  it("returns the unified summaries feed sorted desc with counts and diff stats", async () => {
    const prRow = {
      id: "00000000-0000-4000-8000-000000000b01",
      prNumber: 14,
      title: "feat(rides): classify ride pace",
      author: "AntonyLajes",
      baseBranch: "main",
      mergedAt: new Date("2026-06-03T12:00:00.000Z"),
      summaryUserFacing: "Adds pace classification for rides.",
      additions: 36,
      deletions: 0,
      changedFiles: 2,
      notionPageId: "notion-1",
    };
    const pushRow = {
      id: "00000000-0000-4000-8000-000000000b02",
      title: "Push to main — 1 commit",
      branch: "main",
      pusher: "AntonyLajes",
      pushedAt: new Date("2026-06-03T13:00:00.000Z"),
      commitCount: 1,
      summaryUserFacing: "Guards NaN speeds in pace classification.",
      additions: 6,
      deletions: 1,
      changedFiles: 1,
      notionPageId: null,
    };
    const releaseRow = {
      id: "00000000-0000-4000-8000-000000000b03",
      shortVersion: "1.3.1",
      buildVersion: "13",
      branch: "main",
      createdAt: new Date("2026-06-03T14:00:00.000Z"),
      changelog: "Pace classification ships to riders.",
      notionPageId: null,
    };

    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      // feed pages: pr → push → version
      .mockImplementationOnce(feedSelect([prRow]))
      .mockImplementationOnce(feedSelect([pushRow]))
      .mockImplementationOnce(feedSelect([releaseRow]))
      // counts: pr → push → version
      .mockImplementationOnce(countSelect(5))
      .mockImplementationOnce(countSelect(3))
      .mockImplementationOnce(countSelect(2));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/summaries",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.counts).toEqual({ all: 10, pr: 5, push: 3, version: 2 });
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((i: { type: string }) => i.type)).toEqual([
      "version",
      "push",
      "pr",
    ]);
    expect(body.items[2]).toMatchObject({
      id: prRow.id,
      type: "pr",
      title: "feat(rides): classify ride pace",
      author: "AntonyLajes",
      branch: "main",
      prNumber: 14,
      additions: 36,
      deletions: 0,
      changedFiles: 2,
      delivered: true,
      summaryPreview: "Adds pace classification for rides.",
    });
    expect(body.items[0]).toMatchObject({
      type: "version",
      title: "Version 1.3.1 (13)",
      shortVersion: "1.3.1",
      author: null,
      delivered: false,
    });
  });

  it("filters the feed by type and paginates with a cursor", async () => {
    const olderPush = {
      id: "00000000-0000-4000-8000-000000000b12",
      title: "Push to main — 2 commits",
      branch: "main",
      pusher: "AntonyLajes",
      pushedAt: new Date("2026-06-01T10:00:00.000Z"),
      commitCount: 2,
      summaryUserFacing: null,
      additions: null,
      deletions: null,
      changedFiles: null,
      notionPageId: null,
    };
    const newerPush = {
      ...olderPush,
      id: "00000000-0000-4000-8000-000000000b11",
      pushedAt: new Date("2026-06-02T10:00:00.000Z"),
    };

    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      // only the push feed is queried (limit+1 rows returned → has more)
      .mockImplementationOnce(feedSelect([newerPush, olderPush]))
      .mockImplementationOnce(countSelect(4))
      .mockImplementationOnce(countSelect(9))
      .mockImplementationOnce(countSelect(1));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/summaries?type=push&limit=1",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ type: "push", commitCount: 2 });
    expect(body.nextCursor).toBe("2026-06-02T10:00:00.000Z");
    // lookup + 1 feed + 3 counts — pr/release feed tables never queried
    expect(select).toHaveBeenCalledTimes(5);
  });

  it("returns an empty feed when the workspace has no linked repo", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([{ ...feedWorkspaceRow, repoFullName: null }]));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/summaries",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [],
      nextCursor: null,
      counts: { all: 0, pr: 0, push: 0, version: 0 },
    });
  });

  it("returns 400 for an invalid feed type", async () => {
    const select = vi.fn().mockImplementationOnce(lookupSelect([feedWorkspaceRow]));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/summaries?type=nope",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_type" });
  });

  it("returns per-workspace productivity stats with weekly deltas", async () => {
    /** select().from().where() — awaited aggregate (no orderBy/limit). */
    const aggregateSelect = (rows: unknown[]) => () => ({
      from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
    });

    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      // aggregates: pr → push → version
      .mockImplementationOnce(aggregateSelect([{ total: 5, week: 2 }]))
      .mockImplementationOnce(aggregateSelect([{ total: 3, week: 1 }]))
      .mockImplementationOnce(aggregateSelect([{ total: 2, week: 1 }]));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/stats",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      stats: {
        summaries: 10,
        prs: 5,
        pushes: 3,
        versions: 2,
        reviewTimeSavedMinutes: 115,
        weekDeltas: {
          summaries: 4,
          prs: 2,
          pushes: 1,
          versions: 1,
          reviewTimeSavedMinutes: 45,
        },
      },
    });
  });

  it("returns zeroed stats when the workspace has no linked repo", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([{ ...feedWorkspaceRow, repoFullName: null }]));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/stats",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.stats.summaries).toBe(0);
    expect(body.stats.weekDeltas.summaries).toBe(0);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("returns the full PR summary detail with technical summary and diff stats", async () => {
    const prRow = {
      id: "00000000-0000-4000-8000-000000000b21",
      prNumber: 14,
      title: "feat(rides): classify ride pace",
      author: "AntonyLajes",
      baseBranch: "main",
      mergedAt: new Date("2026-06-03T12:00:00.000Z"),
      headSha: "abc1234",
      summaryUserFacing: "Adds pace classification for rides.",
      summaryTechnical: "Introduces classifyRidePace with thresholds.",
      category: "feature",
      area: "rides",
      additions: 36,
      deletions: 0,
      changedFiles: 2,
      notionPageId: "notion-1",
    };

    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(detailSelect([prRow]));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: `/api/me/workspaces/by-slug/ride-pack/summaries/pr/${prRow.id}`,
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      summary: {
        id: prRow.id,
        type: "pr",
        title: "feat(rides): classify ride pace",
        author: "AntonyLajes",
        branch: "main",
        timestamp: "2026-06-03T12:00:00.000Z",
        prNumber: 14,
        headSha: "abc1234",
        summaryUserFacing: "Adds pace classification for rides.",
        summaryTechnical: "Introduces classifyRidePace with thresholds.",
        category: "feature",
        area: "rides",
        additions: 36,
        deletions: 0,
        changedFiles: 2,
        delivered: true,
        commitCount: null,
        shortVersion: null,
      },
    });
  });

  it("returns 404 when the summary detail row does not exist for the repo", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(detailSelect([]));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/summaries/push/00000000-0000-4000-8000-000000000b31",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "summary_not_found" });
  });

  /* ------------------------------------------------------------------ */
  /* Sample summary on create (Fase 3d)                                  */
  /* ------------------------------------------------------------------ */

  const createWorkspaceDb = () => {
    const createdRow = {
      id: "00000000-0000-4000-8000-0000000000aa",
      name: "acme-app",
      slug: "acme-app",
      sourceProvider: "github",
      workspaceKind: null as string | null,
      repoFullName: "acme/acme-app",
      repoDefaultBranch: "main",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const jobValues = vi.fn(async () => undefined);
    const insert = vi
      .fn()
      // workspace insert
      .mockImplementationOnce(() => ({
        values: vi.fn(() => ({ returning: vi.fn(async () => [createdRow]) })),
      }))
      // sample process_pr job insert
      .mockImplementationOnce(() => ({ values: jobValues }));
    return { insert, jobValues };
  };

  it("enqueues a sample process_pr job for the latest merged PR after create", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("gh-token");
    pullsListMock.mockResolvedValue({
      data: [
        { number: 41, merged_at: null },
        { number: 40, merged_at: "2026-06-01T10:00:00.000Z" },
      ],
    });

    const { insert, jobValues } = createWorkspaceDb();
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { repoFullName: "acme/acme-app" },
    });

    expect(response.statusCode).toBe(201);
    // Fire-and-forget: the job lands after the response is already out.
    await vi.waitFor(() => {
      expect(jobValues).toHaveBeenCalledWith({
        type: "process_pr",
        payload: { repo: "acme/acme-app", prNumber: 40 },
        status: "pending",
      });
    });
    expect(pullsListMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "acme-app", state: "closed" }),
    );
  });

  it("skips the sample job when the repo has no merged PRs", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("gh-token");
    pullsListMock.mockResolvedValue({ data: [{ number: 2, merged_at: null }] });

    const { insert } = createWorkspaceDb();
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { repoFullName: "acme/acme-app" },
    });

    expect(response.statusCode).toBe(201);
    await vi.waitFor(() => {
      expect(pullsListMock).toHaveBeenCalledOnce();
    });
    // Only the workspace insert — no job row.
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("still creates the workspace when the sample-summary lookup fails", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("gh-token");
    pullsListMock.mockRejectedValue(new Error("github_down"));

    const { insert } = createWorkspaceDb();
    const db = { insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { repoFullName: "acme/acme-app" },
    });

    expect(response.statusCode).toBe(201);
    await vi.waitFor(() => {
      expect(pullsListMock).toHaveBeenCalledOnce();
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for an invalid summary detail type or id", async () => {
    const select = vi.fn().mockImplementation(lookupSelect([feedWorkspaceRow]));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const badType = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/summaries/commit/00000000-0000-4000-8000-000000000b31",
      headers: { authorization: `Bearer ${feedToken()}` },
    });
    expect(badType.statusCode).toBe(400);
    expect(badType.json()).toMatchObject({ error: "invalid_type" });

    const badId = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/summaries/pr/not-a-uuid",
      headers: { authorization: `Bearer ${feedToken()}` },
    });
    expect(badId.statusCode).toBe(400);
    expect(badId.json()).toMatchObject({ error: "invalid_id" });
  });
});
