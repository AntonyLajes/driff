import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { DEFAULT_HISTORY_EXCLUDED_PATHS } from "@/config/history-content-filter.js";
import { handler } from "@/http/routes/workspaces-me.js";

vi.mock("@/workspaces/infer-workspace-settings.js", () => ({
  inferAndApplyWorkspaceSettings: vi.fn(),
}));

/* Sample-summary enqueue (Fase 3d) looks up the latest merged PR via Octokit. */
const { pullsListMock, reposGetContentMock } = vi.hoisted(() => ({
  pullsListMock: vi.fn(),
  reposGetContentMock: vi.fn(),
}));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = {
      pulls: { list: pullsListMock },
      repos: { getContent: reposGetContentMock },
    };
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
    reposGetContentMock.mockReset();
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

  it("returns ready diagnostics when summaries and release detection are configured", async () => {
    const settingsRow = {
      releaseProjectKind: "react_native_expo",
      releaseVersionFilePath: "app.json",
      releaseVersionBranch: "main",
      pushSummaryBranches: ["main"],
    };
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(lookupSelect([settingsRow]))
      .mockImplementationOnce(lookupSelect([{ id: "destination-id" }]));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/diagnostics",
      headers: { authorization: `Bearer ${feedToken()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().diagnostics).toMatchObject({
      status: "ready",
      checks: {
        repoLinked: true,
        destinationConnected: true,
        prSummaryReady: true,
        releaseSummaryReady: true,
        pushSummaryReady: true,
      },
      issues: [],
    });
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
  /** select().from().where().orderBy() — evidence linked to a summary. */
  const evidenceSelect = (rows: unknown[]) => () => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ orderBy: vi.fn(async () => rows) })),
    })),
  });
  /** select().from().innerJoin().where().orderBy().limit() — correction audit lookup. */
  const correctionSelect = (rows: unknown[]) => () => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
        })),
      })),
    })),
  });

  /** A shared (non-personal) team the user belongs to with a given role. */
  const SHARED_TEAM_ID = "00000000-0000-4000-8000-0000000000ee";
  /** resolveTeamContext membership join: select().from().innerJoin().where().limit(). */
  const membershipSelect = (role: string) => () => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [{ role, isPersonal: false }]) })),
      })),
    })),
  });

  it("blocks a member from creating a workspace in a shared team", async () => {
    const select = vi.fn().mockImplementationOnce(membershipSelect("member"));
    const insert = vi.fn();
    const db = { select, insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${feedToken()}`, "x-team-id": SHARED_TEAM_ID },
      payload: { repoFullName: "acme/acme-app" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "insufficient_role" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("blocks a member from deleting a workspace in a shared team", async () => {
    const select = vi.fn().mockImplementationOnce(membershipSelect("member"));
    const deleteFn = vi.fn();
    const db = { select, delete: deleteFn } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "DELETE",
      url: "/api/me/workspaces/00000000-0000-4000-8000-0000000000ae",
      headers: { authorization: `Bearer ${feedToken()}`, "x-team-id": SHARED_TEAM_ID },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "insufficient_role" });
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("blocks a member from patching workspace settings in a shared team", async () => {
    const select = vi
      .fn()
      // resolveTeamContext membership → member
      .mockImplementationOnce(membershipSelect("member"))
      // workspace-by-slug lookup within the team
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]));
    const update = vi.fn();
    const db = { select, update, insert: vi.fn() } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/me/workspaces/by-slug/ride-pack/settings",
      headers: { authorization: `Bearer ${feedToken()}`, "x-team-id": SHARED_TEAM_ID },
      payload: { pushSummaryBranches: ["main"] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "insufficient_role" });
    expect(update).not.toHaveBeenCalled();
  });

  it("lets a member read the summaries feed in a shared team", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("member"))
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(feedSelect([]))
      .mockImplementationOnce(feedSelect([]))
      .mockImplementationOnce(feedSelect([]))
      .mockImplementationOnce(countSelect(0))
      .mockImplementationOnce(countSelect(0))
      .mockImplementationOnce(countSelect(0));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/summaries",
      headers: { authorization: `Bearer ${feedToken()}`, "x-team-id": SHARED_TEAM_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().counts).toEqual({ all: 0, pr: 0, push: 0, version: 0 });
  });

  it("lets an admin create a workspace in a shared team", async () => {
    const createdRow = {
      id: "00000000-0000-4000-8000-0000000000aa",
      name: "acme-app",
      slug: "acme-app",
      sourceProvider: "github",
      workspaceKind: null,
      repoFullName: "acme/acme-app",
      repoDefaultBranch: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const select = vi.fn().mockImplementationOnce(membershipSelect("admin"));
    const returning = vi.fn(async () => [createdRow]);
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const db = { select, insert } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${feedToken()}`, "x-team-id": SHARED_TEAM_ID },
      payload: { repoFullName: "acme/acme-app" },
    });

    expect(response.statusCode).toBe(201);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: SHARED_TEAM_ID, slug: "acme-app" }),
    );
  });

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

  it("returns a version-only feed with null previews and missing count rows", async () => {
    const releaseRow = {
      id: "00000000-0000-4000-8000-000000000b13",
      shortVersion: "2.0.0",
      buildVersion: "20",
      branch: null,
      createdAt: new Date("2026-06-04T10:00:00.000Z"),
      changelog: null,
      notionPageId: "page-1",
    };
    const emptyCount = () => ({
      from: vi.fn(() => ({ where: vi.fn(async () => []) })),
    });
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(feedSelect([releaseRow]))
      .mockImplementationOnce(emptyCount)
      .mockImplementationOnce(emptyCount)
      .mockImplementationOnce(emptyCount);
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/summaries?type=version&limit=invalid&q=%20%20",
      headers: { authorization: `Bearer ${feedToken()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ type: "version", summaryPreview: null, delivered: true }],
      counts: { all: 0, pr: 0, push: 0, version: 0 },
    });
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

  it("defaults missing productivity aggregates to zero", async () => {
    const aggregateSelect = () => ({
      from: vi.fn(() => ({ where: vi.fn(async () => []) })),
    });
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(aggregateSelect)
      .mockImplementationOnce(aggregateSelect)
      .mockImplementationOnce(aggregateSelect);
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/stats",
      headers: { authorization: `Bearer ${feedToken()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().stats).toMatchObject({ summaries: 0, weekDeltas: { summaries: 0 } });
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
      .mockImplementationOnce(detailSelect([prRow]))
      .mockImplementationOnce(
        evidenceSelect([
          {
            id: "00000000-0000-4000-8000-000000000b22",
            kind: "pull_request",
            externalId: "14",
            url: "https://github.com/AntonyLajes/ride-pack/pull/14",
            sha: "abc1234",
            path: null,
            occurredAt: new Date("2026-06-03T12:00:00.000Z"),
          },
        ]),
      )
      .mockImplementationOnce(
        correctionSelect([
          {
            correctedAt: new Date("2026-06-04T10:00:00.000Z"),
            correctedByUserId: "00000000-0000-4000-8000-000000000099",
            correctedByName: "Antony Lajes",
            correctedByEmail: "user@example.com",
          },
        ]),
      );
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
        evidence: [
          {
            kind: "pull_request",
            externalId: "14",
            url: "https://github.com/AntonyLajes/ride-pack/pull/14",
            occurredAt: "2026-06-03T12:00:00.000Z",
          },
        ],
        correction: {
          correctedAt: "2026-06-04T10:00:00.000Z",
          correctedBy: {
            id: "00000000-0000-4000-8000-000000000099",
            name: "Antony Lajes",
            email: "user@example.com",
          },
        },
      },
    });
  });

  it("returns push and version summary detail shapes", async () => {
    const pushRow = {
      id: "00000000-0000-4000-8000-000000000b31",
      title: "Push to main",
      branch: "main",
      pusher: null,
      pushedAt: new Date("2026-06-03T12:00:00.000Z"),
      commitCount: 2,
      compareUrl: null,
      prNumbers: null,
      summaryUserFacing: null,
      summaryTechnical: null,
      category: "chore",
      area: null,
      additions: null,
      deletions: null,
      changedFiles: null,
      notionPageId: null,
    };
    const releaseRow = {
      id: "00000000-0000-4000-8000-000000000b32",
      shortVersion: "2.0.0",
      buildVersion: "20",
      branch: "main",
      headSha: null,
      createdAt: new Date("2026-06-04T12:00:00.000Z"),
      prNumbers: null,
      changelog: "Major release",
      sections: undefined,
      notionPageId: "page-1",
    };
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(detailSelect([pushRow]))
      .mockImplementationOnce(evidenceSelect([]))
      .mockImplementationOnce(correctionSelect([]))
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(detailSelect([releaseRow]))
      .mockImplementationOnce(evidenceSelect([]))
      .mockImplementationOnce(correctionSelect([]));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();
    const push = await server.inject({
      method: "GET",
      url: `/api/me/workspaces/by-slug/ride-pack/summaries/push/${pushRow.id}`,
      headers: { authorization: `Bearer ${feedToken()}` },
    });
    const version = await server.inject({
      method: "GET",
      url: `/api/me/workspaces/by-slug/ride-pack/summaries/version/${releaseRow.id}`,
      headers: { authorization: `Bearer ${feedToken()}` },
    });
    expect(push.statusCode).toBe(200);
    expect(push.json().summary).toMatchObject({ type: "push", commitCount: 2, delivered: false });
    expect(version.statusCode).toBe(200);
    expect(version.json().summary).toMatchObject({
      type: "version",
      title: "Version 2.0.0 (20)",
      sections: null,
      delivered: true,
    });
  });

  it("allows workspace editors to correct a generated summary", async () => {
    const summaryId = "00000000-0000-4000-8000-000000000b41";
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(
        detailSelect([
          {
            summaryUserFacing: "Old customer impact.",
            summaryTechnical: "Old implementation.",
          },
        ]),
      );
    const returning = vi.fn(async () => [{ id: summaryId }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select, update, insert } as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: `/api/me/workspaces/by-slug/ride-pack/summaries/pr/${summaryId}`,
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: {
        summaryUserFacing: "  Customers can now plan fuel stops.  ",
        summaryTechnical: "  Adds deterministic stop estimates.  ",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ updated: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryUserFacing: "Customers can now plan fuel stops.",
        summaryTechnical: "Adds deterministic stop estimates.",
      }),
    );
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: feedWorkspaceRow.id,
        sourceRecordType: "pull_requests",
        sourceRecordId: summaryId,
        editedByUserId: "00000000-0000-4000-8000-000000000099",
        beforeUserFacing: "Old customer impact.",
        beforeTechnical: "Old implementation.",
        afterUserFacing: "Customers can now plan fuel stops.",
        afterTechnical: "Adds deterministic stop estimates.",
      }),
    );
  });

  it("rejects an empty summary correction", async () => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select: vi.fn() } as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/me/workspaces/by-slug/ride-pack/summaries/pr/00000000-0000-4000-8000-000000000b41",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { summaryUserFacing: "" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_body" });
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

  it("returns the workspace shell and its normalized settings", async () => {
    const settingsRow = {
      pushSummaryBranches: ["main"],
      prSummaryBaseBranches: ["main", "develop"],
      releaseProjectKind: "react_native_expo",
      releaseVersionFilePath: "app.json",
      releaseVersionBranch: "main",
    };
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(lookupSelect([settingsRow]));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();

    const detail = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack",
      headers: { authorization: `Bearer ${feedToken()}` },
    });
    const settings = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/settings",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(detail.json()).toEqual({
      workspace: expect.objectContaining({ slug: "ride-pack" }),
    });
    expect(settings.json()).toEqual({
      settings: {
        ...settingsRow,
        historyExcludedPaths: [...DEFAULT_HISTORY_EXCLUDED_PATHS],
        historyExcludedActors: [],
      },
    });
  });

  it("returns empty settings when the workspace has never been configured", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(lookupSelect([]));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/settings",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.json()).toEqual({
      settings: {
        pushSummaryBranches: null,
        prSummaryBaseBranches: null,
        releaseProjectKind: null,
        releaseVersionFilePath: null,
        releaseVersionBranch: null,
        historyExcludedPaths: [...DEFAULT_HISTORY_EXCLUDED_PATHS],
        historyExcludedActors: [],
      },
    });
  });

  it("lists manager-facing product areas for a workspace", async () => {
    const updatedAt = new Date("2026-08-09T18:00:00.000Z");
    const areaRows = [
      {
        id: "00000000-0000-4000-8000-0000000000c1",
        name: "Home",
        slug: "home",
        rules: null,
        updatedAt,
        changeCount: 5,
      },
      {
        id: "00000000-0000-4000-8000-0000000000c2",
        name: "Ride Creation",
        slug: "ride-creation",
        rules: { aliases: ["create ride"] },
        updatedAt,
        changeCount: 12,
      },
    ];
    const orderedSelect = () => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn(() => ({ orderBy: vi.fn(async () => areaRows) })),
          })),
        })),
      })),
    });
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(orderedSelect);
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/product-areas",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      areas: areaRows.map((area) => ({ ...area, updatedAt: updatedAt.toISOString() })),
    });
  });

  it("lets a workspace manager rename a product area without changing its slug", async () => {
    const areaId = "00000000-0000-4000-8000-0000000000c1";
    const updatedAt = new Date("2026-08-09T18:00:00.000Z");
    const returning = vi.fn(async () => [
      { id: areaId, name: "Home Experience", slug: "home", rules: null, updatedAt },
    ]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const select = vi.fn().mockImplementationOnce(lookupSelect([feedWorkspaceRow]));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: { select, update: vi.fn(() => ({ set })) } as never,
      jwtSecret,
    });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: `/api/me/workspaces/by-slug/ride-pack/product-areas/${areaId}`,
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { name: "  Home Experience  " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().area).toMatchObject({
      id: areaId,
      name: "Home Experience",
      slug: "home",
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Home Experience", updatedAt: expect.any(Date) }),
    );
  });

  it("blocks a member from renaming a product area in a shared team", async () => {
    const areaId = "00000000-0000-4000-8000-0000000000c1";
    const select = vi
      .fn()
      .mockImplementationOnce(membershipSelect("member"))
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]));
    const update = vi.fn();
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select, update } as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: `/api/me/workspaces/by-slug/ride-pack/product-areas/${areaId}`,
      headers: {
        authorization: `Bearer ${feedToken()}`,
        "x-team-id": SHARED_TEAM_ID,
      },
      payload: { name: "Home Experience" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "insufficient_role" });
    expect(update).not.toHaveBeenCalled();
  });

  it("updates project identity fields in its active team", async () => {
    const workspaceId = "00000000-0000-4000-8000-0000000000aa";
    const returning = vi.fn(async () => [
      { ...feedWorkspaceRow, name: "Ride Pack Mobile", workspaceKind: "ios_pbx" },
    ]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { update } as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: `/api/me/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { name: "  Ride Pack Mobile  ", workspaceKind: "ios_pbx" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().workspace).toMatchObject({
      name: "Ride Pack Mobile",
      workspaceKind: "ios_pbx",
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Ride Pack Mobile", workspaceKind: "ios_pbx" }),
    );
  });

  it("returns 404 when a project update cannot find the workspace", async () => {
    const returning = vi.fn(async () => []);
    const update = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { update } as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/me/workspaces/00000000-0000-4000-8000-0000000000aa",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { name: "Missing" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "workspace_not_found" });
  });

  it("updates an existing release strategy and branch filters", async () => {
    const resultRow = {
      pushSummaryBranches: ["main", "develop"],
      prSummaryBaseBranches: [],
      historyExcludedPaths: ["dist/", "*.generated.*"],
      historyExcludedActors: ["dependabot[bot]"],
      releaseProjectKind: "react_native_expo",
      releaseVersionFilePath: "app.json",
      releaseVersionBranch: "main",
    };
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(lookupSelect([{ id: "settings-id" }]))
      .mockImplementationOnce(lookupSelect([resultRow]));
    const updateWhere = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where: updateWhere }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: { select, update: vi.fn(() => ({ set })) } as never,
      jwtSecret,
    });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/me/workspaces/by-slug/ride-pack/settings",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: {
        pushSummaryBranches: [" main ", " ", " develop "],
        prSummaryBaseBranches: [],
        historyExcludedPaths: [" dist/ ", "*.generated.*", "dist/"],
        historyExcludedActors: [" dependabot[bot] "],
        releaseProjectKind: "react_native_expo",
        releaseVersionFilePath: " app.json ",
        releaseVersionBranch: " main ",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      settings: resultRow,
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        pushSummaryBranches: ["main", "develop"],
        prSummaryBaseBranches: [],
        historyExcludedPaths: ["dist/", "*.generated.*"],
        historyExcludedActors: ["dependabot[bot]"],
        releaseProjectKind: "react_native_expo",
        releaseVersionFilePath: "app.json",
        releaseExpoAppConfigPath: "app.json",
        releaseVersionBranch: "main",
      }),
    );
  });

  it("creates settings and supports explicitly disabling release detection", async () => {
    const resultRow = {
      pushSummaryBranches: null,
      prSummaryBaseBranches: null,
      releaseProjectKind: null,
      releaseVersionFilePath: null,
      releaseVersionBranch: null,
    };
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(lookupSelect([]))
      .mockImplementationOnce(lookupSelect([resultRow]));
    const values = vi.fn(async () => undefined);
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: { select, insert: vi.fn(() => ({ values })) } as never,
      jwtSecret,
    });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/me/workspaces/by-slug/ride-pack/settings",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: {
        pushSummaryBranches: [" ", "  "],
        prSummaryBaseBranches: null,
        releaseProjectKind: null,
        releaseVersionFilePath: null,
        releaseVersionBranch: " ",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: feedWorkspaceRow.id,
        pushSummaryBranches: null,
        prSummaryBaseBranches: null,
        releaseProjectKind: null,
        releaseVersionFilePath: null,
        releaseVersionBranch: null,
        historyExcludedPaths: [...DEFAULT_HISTORY_EXCLUDED_PATHS],
        historyExcludedActors: [],
      }),
    );
  });

  it("creates partial settings with safe defaults for every omitted field", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(lookupSelect([]))
      .mockImplementationOnce(lookupSelect([]));
    const values = vi.fn(async () => undefined);
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: { select, insert: vi.fn(() => ({ values })) } as never,
      jwtSecret,
    });
    await server.ready();
    const response = await server.inject({
      method: "PATCH",
      url: "/api/me/workspaces/by-slug/ride-pack/settings",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { pushSummaryBranches: null },
    });
    expect(response.statusCode).toBe(200);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        pushSummaryBranches: null,
        prSummaryBaseBranches: null,
        releaseProjectKind: null,
        releaseVersionFilePath: null,
        releaseVersionBranch: null,
      }),
    );
    expect(response.json()).toEqual({
      settings: {
        pushSummaryBranches: null,
        prSummaryBaseBranches: null,
        releaseProjectKind: null,
        releaseVersionFilePath: null,
        releaseVersionBranch: null,
        historyExcludedPaths: [...DEFAULT_HISTORY_EXCLUDED_PATHS],
        historyExcludedActors: [],
      },
    });
  });

  it("browses the linked repository with directories first", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValue("github-token");
    reposGetContentMock.mockResolvedValue({
      data: [
        { type: "file", name: "z.ts", path: "src/z.ts" },
        { type: "dir", name: "components", path: "src/components" },
        { type: "symlink", name: "ignored", path: "src/ignored" },
        { type: "file", name: "a.ts", path: "src/a.ts" },
      ],
    });
    const select = vi.fn().mockImplementationOnce(lookupSelect([feedWorkspaceRow]));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/repo/contents?path=src&ref=develop",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ref: "develop",
      requestedPath: "src",
      entries: [
        { name: "components", path: "src/components", type: "dir" },
        { name: "a.ts", path: "src/a.ts", type: "file" },
        { name: "z.ts", path: "src/z.ts", type: "file" },
      ],
    });
  });

  it("returns the compact legacy workspace summary with bounded changelog", async () => {
    const orderedLimited = (rows: unknown[]) => () => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
        })),
      })),
    });
    const longChangelog = "x".repeat(500);
    const select = vi
      .fn()
      .mockImplementationOnce(lookupSelect([feedWorkspaceRow]))
      .mockImplementationOnce(
        orderedLimited([
          {
            id: "release-id",
            shortVersion: "1.4.0",
            buildVersion: "7",
            branch: "main",
            headSha: "a".repeat(40),
            createdAt: new Date("2026-08-08T12:00:00.000Z"),
            changelog: longChangelog,
          },
        ]),
      )
      .mockImplementationOnce(orderedLimited([]))
      .mockImplementationOnce(orderedLimited([]));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/summary",
      headers: { authorization: `Bearer ${feedToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().releases[0].changelogPreview).toHaveLength(481);
    expect(response.json()).toMatchObject({ pullRequests: [], pushes: [] });
  });

  const projectWithRepo = (repoFullName: string | null) => ({
    ...feedWorkspaceRow,
    repoFullName,
  });

  const injectProjectRoute = async (input: {
    method: "GET" | "POST" | "PATCH";
    suffix: string;
    workspace?: ReturnType<typeof projectWithRepo>;
    payload?: Record<string, unknown>;
    query?: string;
  }) => {
    const select = vi.fn().mockImplementationOnce(
      lookupSelect([input.workspace ?? feedWorkspaceRow]),
    );
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();
    return server.inject({
      method: input.method,
      url: `/api/me/workspaces/by-slug/ride-pack${input.suffix}${input.query ?? ""}`,
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: input.payload,
    });
  };

  it("requires a linked repository before inferring settings", async () => {
    const response = await injectProjectRoute({
      method: "POST",
      suffix: "/settings/infer",
      workspace: projectWithRepo(null),
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "workspace_repo_not_linked" });
  });

  it("requires GitHub before inferring settings", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValueOnce(null);
    const response = await injectProjectRoute({ method: "POST", suffix: "/settings/infer", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "github_not_connected" });
  });

  it("validates the inference options", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValueOnce("token");
    const response = await injectProjectRoute({
      method: "POST",
      suffix: "/settings/infer",
      payload: { apply: "yes" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_body" });
  });

  it.each([
    [404, "repo_not_found_or_no_access"],
    [500, "infer_failed"],
  ] as const)("maps inference failures with status %s", async (status, error) => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValueOnce("token");
    vi.mocked(inferAndApplyWorkspaceSettings).mockRejectedValueOnce(
      status === 404 ? Object.assign(new Error("missing"), { status }) : new Error("boom"),
    );
    const response = await injectProjectRoute({ method: "POST", suffix: "/settings/infer", payload: {} });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error });
  });

  it("requires a linked repository before browsing files", async () => {
    const response = await injectProjectRoute({
      method: "GET",
      suffix: "/repo/contents",
      workspace: projectWithRepo(null),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "workspace_repo_not_linked" });
  });

  it("requires GitHub before browsing files", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValueOnce(null);
    const response = await injectProjectRoute({ method: "GET", suffix: "/repo/contents" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "github_not_connected" });
  });

  it("validates repository browsing queries", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValueOnce("token");
    const response = await injectProjectRoute({
      method: "GET",
      suffix: "/repo/contents",
      query: `?path=${"a".repeat(2049)}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_query" });
  });

  it("rejects a malformed linked repository name", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValueOnce("token");
    const response = await injectProjectRoute({
      method: "GET",
      suffix: "/repo/contents",
      workspace: projectWithRepo("malformed"),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_repo_full_name" });
  });

  it("returns a single repository file", async () => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValueOnce("token");
    reposGetContentMock.mockResolvedValueOnce({ data: { name: "app.json", path: "app.json" } });
    const response = await injectProjectRoute({ method: "GET", suffix: "/repo/contents" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ref: "main",
      requestedPath: "",
      entries: [{ name: "app.json", path: "app.json", type: "file" }],
    });
  });

  it.each([
    [Object.assign(new Error("missing"), { status: 404 }), 404, "repo_path_not_found"],
    [new Error("boom"), 500, "repo_contents_failed"],
  ] as const)("maps repository browsing failures", async (failure, status, error) => {
    vi.mocked(loadUserGithubAccessToken).mockResolvedValueOnce("token");
    reposGetContentMock.mockRejectedValueOnce(failure);
    const response = await injectProjectRoute({ method: "GET", suffix: "/repo/contents" });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error });
  });

  it.each([
    {},
    { releaseProjectKind: "node_package" },
    { releaseVersionFilePath: "package.json" },
    { releaseProjectKind: null, releaseVersionFilePath: "package.json" },
    { releaseProjectKind: "react_native_expo", releaseVersionFilePath: null },
    { releaseProjectKind: "generic", releaseVersionFilePath: "version.txt" },
    { releaseProjectKind: "react_native_expo", releaseVersionFilePath: " " },
  ])("rejects inconsistent project settings: %j", async (payload) => {
    const response = await injectProjectRoute({ method: "PATCH", suffix: "/settings", payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_body" });
  });

  it("rejects an unsupported project kind during creation", async () => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { repoFullName: "owner/repo", workspaceKind: "unknown" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_workspace_kind" });
  });

  it.each([
    [Object.assign(new Error("conflict"), { code: "23505", constraint_name: "other_unique" }), 409, "workspace_conflict"],
    [new Error("database down"), 500, "internal_error"],
  ] as const)("maps workspace insertion failures", async (failure, status, error) => {
    const returning = vi.fn(async () => Promise.reject(failure));
    const insert = vi.fn(() => ({ values: vi.fn(() => ({ returning })) }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { insert } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { repoFullName: "owner/repo" },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error });
  });

  it("fails safely when an insert returns no workspace", async () => {
    const returning = vi.fn(async () => []);
    const insert = vi.fn(() => ({ values: vi.fn(() => ({ returning })) }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { insert } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { repoFullName: "owner/repo", name: " " },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "insert_failed" });
  });

  it("stops after exhausting every workspace slug suffix", async () => {
    const duplicate = Object.assign(new Error("slug collision"), {
      code: "23505",
      constraint_name: "workspaces_team_id_slug_unique",
    });
    const returning = vi.fn(async () => Promise.reject(duplicate));
    const insert = vi.fn(() => ({ values: vi.fn(() => ({ returning })) }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { insert } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces",
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: { repoFullName: "owner/repo" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "workspace_slug_taken" });
    expect(returning).toHaveBeenCalledTimes(25);
  });

  it.each([
    ["not-a-uuid", { name: "Updated" }, "invalid_workspace_id"],
    ["00000000-0000-4000-8000-0000000000aa", {}, "invalid_body"],
  ] as const)("validates project update input", async (workspaceId, payload, error) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method: "PATCH",
      url: `/api/me/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${feedToken()}` },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error });
  });

  it.each([
    ["PATCH", { name: "Updated" }],
    ["DELETE", undefined],
  ] as const)("rejects an invalid team while mutating a project", async (method, payload) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method,
      url: "/api/me/workspaces/00000000-0000-4000-8000-0000000000aa",
      headers: { authorization: `Bearer ${feedToken()}`, "x-team-id": "invalid" },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_team" });
  });

  it.each([
    ["PATCH", { name: "Updated" }],
    ["DELETE", undefined],
  ] as const)("rejects a non-member while mutating a project", async (method, payload) => {
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
      })),
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method,
      url: "/api/me/workspaces/00000000-0000-4000-8000-0000000000aa",
      headers: { authorization: `Bearer ${feedToken()}`, "x-team-id": SHARED_TEAM_ID },
      payload,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "not_a_team_member" });
  });

  const protectedWorkspaceRoutes = [
    ["GET", "/api/me/workspaces/by-slug/ride-pack/summary"],
    ["GET", "/api/me/workspaces/by-slug/ride-pack/summaries"],
    [
      "GET",
      "/api/me/workspaces/by-slug/ride-pack/summaries/pr/00000000-0000-4000-8000-0000000000ab",
    ],
    ["GET", "/api/me/workspaces/by-slug/ride-pack/stats"],
    ["GET", "/api/me/workspaces/by-slug/ride-pack/settings"],
    ["GET", "/api/me/workspaces/by-slug/ride-pack/diagnostics"],
    ["POST", "/api/me/workspaces/by-slug/ride-pack/settings/infer"],
    ["GET", "/api/me/workspaces/by-slug/ride-pack/repo/contents"],
    ["PATCH", "/api/me/workspaces/by-slug/ride-pack/settings"],
    ["GET", "/api/me/workspaces/by-slug/ride-pack"],
    ["POST", "/api/me/workspaces"],
    ["PATCH", "/api/me/workspaces/00000000-0000-4000-8000-0000000000ab"],
    ["DELETE", "/api/me/workspaces/00000000-0000-4000-8000-0000000000ab"],
  ] as const;

  it.each(protectedWorkspaceRoutes)("protects %s %s without authorization", async (method, url) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method,
      url,
      payload:
        method === "POST"
          ? url === "/api/me/workspaces"
            ? { repoFullName: "owner/repo" }
            : {}
          : method === "PATCH"
            ? { name: "Updated" }
            : undefined,
    });
    expect(response.statusCode).toBe(401);
  });

  it.each(protectedWorkspaceRoutes)("rejects an invalid JWT for %s %s", async (method, url) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method,
      url,
      headers: { authorization: "Bearer invalid" },
      payload: method === "POST" ? {} : method === "PATCH" ? { name: "Updated" } : undefined,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "invalid_session" });
  });

  const slugWorkspaceRoutes = [
    ["GET", "/summary"],
    ["GET", "/summaries"],
    ["GET", "/summaries/pr/00000000-0000-4000-8000-0000000000ab"],
    ["GET", "/stats"],
    ["GET", "/settings"],
    ["GET", "/diagnostics"],
    ["POST", "/settings/infer"],
    ["GET", "/repo/contents"],
    ["PATCH", "/settings"],
    ["GET", ""],
  ] as const;

  it.each(slugWorkspaceRoutes)("rejects an invalid slug for %s %s", async (method, suffix) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method,
      url: `/api/me/workspaces/by-slug/---${suffix}`,
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: method === "POST" ? {} : method === "PATCH" ? { pushSummaryBranches: ["main"] } : undefined,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_slug" });
  });

  it.each(slugWorkspaceRoutes)("returns not found for a missing project from %s %s", async (method, suffix) => {
    const select = vi.fn().mockImplementationOnce(lookupSelect([]));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method,
      url: `/api/me/workspaces/by-slug/missing${suffix}`,
      headers: { authorization: `Bearer ${feedToken()}` },
      payload: method === "POST" ? {} : method === "PATCH" ? { pushSummaryBranches: ["main"] } : undefined,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "workspace_not_found" });
  });

  it.each(slugWorkspaceRoutes)("rejects an invalid team for %s %s", async (method, suffix) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method,
      url: `/api/me/workspaces/by-slug/ride-pack${suffix}`,
      headers: { authorization: `Bearer ${feedToken()}`, "x-team-id": "invalid" },
      payload: method === "POST" ? {} : method === "PATCH" ? { pushSummaryBranches: ["main"] } : undefined,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_team" });
  });

  it.each(slugWorkspaceRoutes)("rejects a non-member for %s %s", async (method, suffix) => {
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
      })),
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: { select } as never, jwtSecret });
    await server.ready();
    const response = await server.inject({
      method,
      url: `/api/me/workspaces/by-slug/ride-pack${suffix}`,
      headers: { authorization: `Bearer ${feedToken()}`, "x-team-id": SHARED_TEAM_ID },
      payload: method === "POST" ? {} : method === "PATCH" ? { pushSummaryBranches: ["main"] } : undefined,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "not_a_team_member" });
  });
});
