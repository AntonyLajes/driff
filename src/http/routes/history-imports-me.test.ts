import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import type { HistoryImportRepository } from "@/history-imports/history-import-repository.js";
import { handler } from "@/http/routes/history-imports-me.js";

const JWT_SECRET = "h".repeat(32);
const USER_ID = "00000000-0000-4000-8000-000000000099";
const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000aa";
const IMPORT_ID = "00000000-0000-4000-8000-0000000000bb";

const historyImport = {
  id: IMPORT_ID,
  workspaceId: WORKSPACE_ID,
  requestedByUserId: USER_ID,
  status: "pending" as const,
  periodMonths: 12,
  maxPullRequests: 100,
  totalItems: 0,
  processedItems: 0,
  failedItems: 0,
  completedPrNumbers: [],
  failures: [],
  truncated: false,
  cancelRequested: false,
  lastError: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date("2026-08-09T12:00:00.000Z"),
  updatedAt: new Date("2026-08-09T12:00:00.000Z"),
};

const repository = () =>
  ({
    create: vi.fn(async () => historyImport),
    findLatestForWorkspace: vi.fn(async () => historyImport),
    markFailed: vi.fn(async () => undefined),
    requestCancellation: vi.fn(async () => true),
  }) as unknown as HistoryImportRepository;

const token = () =>
  signSessionJwt({
    secret: JWT_SECRET,
    userId: USER_ID,
    email: "user@example.com",
    expiresInSeconds: 3600,
  });

describe("http/routes/history-imports-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  const setup = async (options?: {
    role?: "owner" | "admin" | "member";
    accessKind?:
      | "ok"
      | "invalid_team"
      | "not_a_member"
      | "invalid_slug"
      | "not_found";
    sourceProvider?: string;
    repoFullName?: string | null;
  }) => {
    const server = fastify({ logger: false });
    servers.push(server);
    const repo = repository();
    const enqueue = vi.fn(async () => undefined);
    await handler(server, {
      db: {} as never,
      jwtSecret: JWT_SECRET,
      repository: repo,
      enqueue,
      resolveWorkspace: vi.fn(async () =>
        options?.accessKind !== undefined && options.accessKind !== "ok"
          ? { kind: options.accessKind }
          : {
              kind: "ok" as const,
              workspace: {
                id: WORKSPACE_ID,
                sourceProvider: options?.sourceProvider ?? "github",
                repoFullName:
                  options?.repoFullName === undefined
                    ? "acme/mobile"
                    : options.repoFullName,
              },
              role: options?.role ?? "owner",
            },
      ),
    });
    await server.ready();
    return { server, repo, enqueue };
  };

  it("should start a bounded import and enqueue its orchestrator", async () => {
    const { server, repo, enqueue } = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/mobile/history-imports",
      headers: { authorization: `Bearer ${token()}` },
      payload: { periodMonths: 6, maxPullRequests: 50 },
    });

    expect(response.statusCode).toBe(202);
    expect(repo.create).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      requestedByUserId: USER_ID,
      periodMonths: 6,
      maxPullRequests: 50,
    });
    expect(enqueue).toHaveBeenCalledWith({
      importId: IMPORT_ID,
      workspaceId: WORKSPACE_ID,
      repo: "acme/mobile",
    });
  });

  it("should expose the latest import to read-only members", async () => {
    const { server } = await setup({ role: "member" });
    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/mobile/history-imports/latest",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().historyImport.id).toBe(IMPORT_ID);
  });

  it("should prevent read-only members from starting imports", async () => {
    const { server, repo } = await setup({ role: "member" });
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/mobile/history-imports",
      headers: { authorization: `Bearer ${token()}` },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "insufficient_role" });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("should request cancellation for an active import", async () => {
    const { server, repo } = await setup();
    const response = await server.inject({
      method: "DELETE",
      url: `/api/me/workspaces/by-slug/mobile/history-imports/${IMPORT_ID}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(202);
    expect(repo.requestCancellation).toHaveBeenCalledWith(
      WORKSPACE_ID,
      IMPORT_ID,
      expect.any(Date),
    );
  });

  it("should reject unauthenticated reads", async () => {
    const { server } = await setup();
    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/mobile/history-imports/latest",
    });

    expect(response.statusCode).toBe(401);
  });

  it("should reject invalid sessions", async () => {
    const { server } = await setup();
    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/mobile/history-imports/latest",
      headers: { authorization: "Bearer invalid" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_session" });
  });

  it.each([
    ["invalid_team", 400, "invalid_team"],
    ["not_a_member", 403, "not_a_team_member"],
    ["invalid_slug", 400, "invalid_workspace_slug"],
    ["not_found", 404, "workspace_not_found"],
  ] as const)(
    "should map %s workspace access",
    async (accessKind, status, error) => {
      const { server } = await setup({ accessKind });
      const response = await server.inject({
        method: "GET",
        url: "/api/me/workspaces/by-slug/mobile/history-imports/latest",
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error });
    },
  );

  it("should validate import bounds", async () => {
    const { server, repo } = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/mobile/history-imports",
      headers: { authorization: `Bearer ${token()}` },
      payload: { periodMonths: 0, maxPullRequests: 500 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_body" });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ sourceProvider: "gitlab" }, "github_repo_required"],
    [{ repoFullName: null }, "github_repo_required"],
  ] as const)("should require a linked GitHub repo", async (options, error) => {
    const { server } = await setup(options);
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/mobile/history-imports",
      headers: { authorization: `Bearer ${token()}` },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error });
  });

  it("should return the active import when a concurrent start wins", async () => {
    const { server, repo } = await setup();
    vi.mocked(repo.create).mockRejectedValue({
      code: "23505",
      constraint_name: "history_imports_active_workspace_unique",
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/mobile/history-imports",
      headers: { authorization: `Bearer ${token()}` },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "history_import_active",
      historyImport: { id: IMPORT_ID },
    });
  });

  it("should persist an enqueue failure on the import", async () => {
    const { server, repo, enqueue } = await setup();
    enqueue.mockRejectedValue(new Error("queue offline"));
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/mobile/history-imports",
      headers: { authorization: `Bearer ${token()}` },
      payload: {},
    });

    expect(response.statusCode).toBe(500);
    expect(repo.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: IMPORT_ID, message: "queue offline" }),
    );
  });

  it("should report missing imports during cancellation", async () => {
    const { server, repo } = await setup();
    vi.mocked(repo.requestCancellation).mockResolvedValue(false);
    const response = await server.inject({
      method: "DELETE",
      url: `/api/me/workspaces/by-slug/mobile/history-imports/${IMPORT_ID}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "history_import_not_found" });
  });

  it("should reject malformed cancellation ids", async () => {
    const { server } = await setup();
    const response = await server.inject({
      method: "DELETE",
      url: "/api/me/workspaces/by-slug/mobile/history-imports/not-a-uuid",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_params" });
  });

  it("should reject unauthenticated import starts", async () => {
    const { server } = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/mobile/history-imports",
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it("should reject invalid sessions when starting imports", async () => {
    const { server } = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/mobile/history-imports",
      headers: { authorization: "Bearer invalid" },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it("should reject cancellation by read-only members", async () => {
    const { server, repo } = await setup({ role: "member" });
    const response = await server.inject({
      method: "DELETE",
      url: `/api/me/workspaces/by-slug/mobile/history-imports/${IMPORT_ID}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(403);
    expect(repo.requestCancellation).not.toHaveBeenCalled();
  });

  it("should reject unauthenticated cancellation", async () => {
    const { server } = await setup();
    const response = await server.inject({
      method: "DELETE",
      url: `/api/me/workspaces/by-slug/mobile/history-imports/${IMPORT_ID}`,
    });

    expect(response.statusCode).toBe(401);
  });
});
