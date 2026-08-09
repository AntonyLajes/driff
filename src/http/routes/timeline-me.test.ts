import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/timeline-me.js";

const JWT_SECRET = "t".repeat(32);
const USER_ID = "00000000-0000-4000-8000-000000000099";
const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000aa";
const VERSION_ID = "00000000-0000-4000-8000-0000000000bb";
const BASE_VERSION_ID = "00000000-0000-4000-8000-0000000000cc";

const canonicalChange = (id: string, title: string) => ({
  id,
  title,
  summaryExecutive: null,
  summaryTechnical: null,
  category: "feature",
  confidence: null,
  firstOccurredAt: "2026-08-08T11:00:00.000Z",
  lastOccurredAt: "2026-08-08T11:00:00.000Z",
  areas: [],
  contributors: [],
  evidence: [],
});

const canonicalVersion = (
  id: string,
  displayVersion: string,
  changes: ReturnType<typeof canonicalChange>[],
) => ({
  id,
  displayVersion,
  normalizedVersion: `${displayVersion}+1`,
  buildVersion: "1",
  title: `Version ${displayVersion}`,
  changelog: null,
  sections: null,
  sourceUrl: null,
  previousVersionId: null,
  beforeSha: null,
  headSha: null,
  releasedAt: "2026-08-08T12:00:00.000Z",
  changes,
});

const token = () =>
  signSessionJwt({
    secret: JWT_SECRET,
    userId: USER_ID,
    email: "user@example.com",
    expiresInSeconds: 3600,
  });

const buildWorkspaceDb = (rows: unknown[]) => {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as never, select };
};

describe("http/routes/timeline-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("should reject requests without a bearer session", async () => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret: JWT_SECRET });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/timeline",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "missing_or_invalid_authorization",
    });
  });

  it("should return a workspace-scoped timeline and accept its opaque cursor", async () => {
    const workspaceDb = buildWorkspaceDb([
      { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
    ]);
    const releasedAt = new Date("2026-08-08T12:00:00.000Z");
    const timelineReader = vi
      .fn()
      .mockResolvedValueOnce({
        versions: [],
        inDevelopment: { changes: [], hasMore: false },
        pageInfo: {
          hasNextPage: true,
          nextCursor: { releasedAt, id: VERSION_ID },
        },
      })
      .mockResolvedValueOnce({
        versions: [],
        inDevelopment: null,
        pageInfo: { hasNextPage: false, nextCursor: null },
      });
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      timelineReader,
    });
    await server.ready();

    const first = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/timeline?limit=5",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.workspace).toEqual({
      id: WORKSPACE_ID,
      name: "ride-pack",
      slug: "ride-pack",
    });
    expect(firstBody.pageInfo).toEqual({
      hasNextPage: true,
      nextCursor: expect.any(String),
    });
    expect(timelineReader).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        limit: 5,
        cursor: null,
      }),
    );

    const second = await server.inject({
      method: "GET",
      url: `/api/me/workspaces/by-slug/ride-pack/timeline?cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor)}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().inDevelopment).toBeNull();
    expect(timelineReader).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        limit: 10,
        cursor: { releasedAt, id: VERSION_ID },
      }),
    );
  });

  it("should reject malformed cursors before querying the workspace", async () => {
    const workspaceDb = buildWorkspaceDb([]);
    const timelineReader = vi.fn();
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      timelineReader,
    });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/timeline?cursor=not-a-cursor",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_timeline_cursor" });
    expect(workspaceDb.select).not.toHaveBeenCalled();
    expect(timelineReader).not.toHaveBeenCalled();
  });

  it("should return 404 when the workspace does not belong to the acting team", async () => {
    const workspaceDb = buildWorkspaceDb([]);
    const timelineReader = vi.fn();
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      timelineReader,
    });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/another-project/timeline",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "workspace_not_found" });
    expect(timelineReader).not.toHaveBeenCalled();
  });

  it("should return one workspace-scoped canonical version", async () => {
    const workspaceDb = buildWorkspaceDb([
      { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
    ]);
    const version = {
      id: VERSION_ID,
      displayVersion: "1.3.4",
      normalizedVersion: "1.3.4+6",
      buildVersion: "6",
      title: "Version 1.3.4 (Build 6)",
      changelog: "Improves the home experience.",
      sections: null,
      sourceUrl: "https://github.com/acme/app/compare/a...b",
      previousVersionId: null,
      beforeSha: "a".repeat(40),
      headSha: "b".repeat(40),
      releasedAt: "2026-08-08T12:00:00.000Z",
      changes: [],
    };
    const timelineReader = vi.fn(async () => ({
      versions: [version],
      inDevelopment: null,
      pageInfo: { hasNextPage: false, nextCursor: null },
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      timelineReader,
    });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: `/api/me/workspaces/by-slug/ride-pack/versions/${VERSION_ID}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workspace: { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
      version,
    });
    expect(timelineReader).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        versionId: VERSION_ID,
        limit: 1,
        cursor: null,
      }),
    );
  });

  it("should return workspace-scoped feature histories", async () => {
    const workspaceDb = buildWorkspaceDb([
      { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
    ]);
    const lineages = [
      {
        id: "00000000-0000-4000-8000-0000000000dd",
        key: "home-quick-actions",
        title: "Home quick actions",
        description: null,
        status: "active",
        source: "rule",
        confidence: 100,
        mergedIntoLineageId: null,
        createdAt: "2026-08-08T10:00:00.000Z",
        updatedAt: "2026-08-08T11:00:00.000Z",
        entries: [],
      },
    ];
    const lineageReader = vi.fn(async () => ({ lineages }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      lineageReader,
    });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/lineages",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workspace: { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
      lineages,
    });
    expect(lineageReader).toHaveBeenCalledWith({
      db: workspaceDb.db,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("should reject malformed version identifiers before querying a workspace", async () => {
    const workspaceDb = buildWorkspaceDb([]);
    const timelineReader = vi.fn();
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      timelineReader,
    });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/versions/not-a-version",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_version_request" });
    expect(workspaceDb.select).not.toHaveBeenCalled();
    expect(timelineReader).not.toHaveBeenCalled();
  });

  it("should return 404 for a version outside the workspace", async () => {
    const workspaceDb = buildWorkspaceDb([
      { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
    ]);
    const timelineReader = vi.fn(async () => ({
      versions: [],
      inDevelopment: null,
      pageInfo: { hasNextPage: false, nextCursor: null },
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      timelineReader,
    });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: `/api/me/workspaces/by-slug/ride-pack/versions/${VERSION_ID}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "version_not_found" });
  });

  it("should compare two canonical version snapshots without inferring lineage", async () => {
    const workspaceDb = buildWorkspaceDb([
      { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
    ]);
    const baseChange = canonicalChange("change-base", "Base change");
    const targetChange = canonicalChange("change-target", "Target change");
    const sharedChange = canonicalChange("change-shared", "Shared change");
    const baseVersion = canonicalVersion(BASE_VERSION_ID, "1.3.3", [
      baseChange,
      sharedChange,
    ]);
    const targetVersion = canonicalVersion(VERSION_ID, "1.3.4", [
      targetChange,
      sharedChange,
    ]);
    const timelineReader = vi.fn(async () => ({
      versions: [targetVersion, baseVersion],
      inDevelopment: null,
      pageInfo: { hasNextPage: false, nextCursor: null },
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      timelineReader,
    });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: `/api/me/workspaces/by-slug/ride-pack/versions/${BASE_VERSION_ID}/compare/${VERSION_ID}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workspace: { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
      baseVersion,
      targetVersion,
      comparison: {
        onlyInBase: [baseChange],
        onlyInTarget: [targetChange],
        shared: [sharedChange],
        evolved: [],
        classification: "snapshot",
      },
    });
    expect(timelineReader).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        versionIds: [BASE_VERSION_ID, VERSION_ID],
      }),
    );
  });

  it("should pair changes from the same verified lineage as an evolution", async () => {
    const workspaceDb = buildWorkspaceDb([
      { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
    ]);
    const lineage = {
      id: "00000000-0000-4000-8000-0000000000dd",
      key: "home-quick-actions",
      title: "Home quick actions",
      description: null,
      status: "active",
      source: "rule",
      confidence: 92,
      relationType: "modified",
      assignmentSource: "rule",
      assignmentConfidence: 100,
      correctedAt: null,
    };
    const baseChange = {
      ...canonicalChange("change-base", "Add Home quick actions"),
      lineages: [{ ...lineage, relationType: "introduced" }],
    };
    const targetChange = {
      ...canonicalChange("change-target", "Improve Home quick actions"),
      lineages: [lineage],
    };
    const baseVersion = canonicalVersion(BASE_VERSION_ID, "1.3.3", [
      baseChange,
    ]);
    const targetVersion = canonicalVersion(VERSION_ID, "1.3.4", [
      targetChange,
    ]);
    const timelineReader = vi.fn(async () => ({
      versions: [targetVersion, baseVersion],
      inDevelopment: null,
      pageInfo: { hasNextPage: false, nextCursor: null },
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      timelineReader,
    });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: `/api/me/workspaces/by-slug/ride-pack/versions/${BASE_VERSION_ID}/compare/${VERSION_ID}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().comparison).toEqual({
      onlyInBase: [],
      onlyInTarget: [],
      shared: [],
      evolved: [{ lineage, from: baseChange, to: targetChange }],
      classification: "lineage",
    });
  });

  it("should reject comparing a version with itself", async () => {
    const workspaceDb = buildWorkspaceDb([]);
    const timelineReader = vi.fn();
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      timelineReader,
    });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: `/api/me/workspaces/by-slug/ride-pack/versions/${VERSION_ID}/compare/${VERSION_ID}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "versions_must_be_different" });
    expect(workspaceDb.select).not.toHaveBeenCalled();
    expect(timelineReader).not.toHaveBeenCalled();
  });

  it("should return 404 when either comparison version is outside the workspace", async () => {
    const workspaceDb = buildWorkspaceDb([
      { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
    ]);
    const timelineReader = vi.fn(async () => ({
      versions: [canonicalVersion(VERSION_ID, "1.3.4", [])],
      inDevelopment: null,
      pageInfo: { hasNextPage: false, nextCursor: null },
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      timelineReader,
    });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: `/api/me/workspaces/by-slug/ride-pack/versions/${BASE_VERSION_ID}/compare/${VERSION_ID}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "version_comparison_not_found",
    });
  });
});
