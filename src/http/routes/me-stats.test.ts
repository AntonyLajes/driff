import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/me-stats.js";

describe("http/routes/me-stats", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  const jwtSecret = "a".repeat(32);

  const token = () =>
    signSessionJwt({
      secret: jwtSecret,
      userId: "00000000-0000-4000-8000-000000000099",
      email: "user@example.com",
      expiresInSeconds: 3600,
    });

  const linkedWorkspace = {
    id: "00000000-0000-4000-8000-0000000000aa",
    name: "ride-pack",
    slug: "ride-pack",
    repoFullName: "AntonyLajes/ride-pack",
  };
  const unlinkedWorkspace = {
    id: "00000000-0000-4000-8000-0000000000ab",
    name: "drafts",
    slug: "drafts",
    repoFullName: null,
  };

  /** select().from().where() — awaited directly (workspaces + per-repo aggregates). */
  const flatSelect = (rows: unknown[]) => () => ({
    from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
  });
  /** select().from().where().groupBy() — grouped aggregates. */
  const groupedSelect = (rows: unknown[]) => () => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ groupBy: vi.fn(async () => rows) })),
    })),
  });
  /** select().from().where().orderBy().limit() — recent activity queries. */
  const feedSelect = (rows: unknown[]) => () => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
      })),
    })),
  });

  /** Monday 00:00 UTC of the current week — mirrors the route's bucket alignment. */
  const currentWeekStart = () => {
    const date = new Date();
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCHours(0, 0, 0, 0);
    return new Date(date.getTime() - day * 86_400_000);
  };

  it("returns 401 when Authorization is missing", async () => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret });
    await server.ready();

    const response = await server.inject({ method: "GET", url: "/api/me/stats" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "missing_or_invalid_authorization" });
  });

  it("aggregates totals, weekly buckets and per-project rows across workspaces", async () => {
    const monday = currentWeekStart();

    const select = vi
      .fn()
      // workspaces for the user
      .mockImplementationOnce(flatSelect([linkedWorkspace, unlinkedWorkspace]))
      // grouped totals: pr → push → version
      .mockImplementationOnce(
        groupedSelect([{ repo: "AntonyLajes/ride-pack", total: 5, week: 2 }]),
      )
      .mockImplementationOnce(
        groupedSelect([{ repo: "AntonyLajes/ride-pack", total: 3, week: 1 }]),
      )
      .mockImplementationOnce(
        groupedSelect([{ repo: "AntonyLajes/ride-pack", total: 2, week: 1 }]),
      )
      // weekly buckets: pr → push → version
      .mockImplementationOnce(groupedSelect([{ week: monday, value: 2 }]))
      .mockImplementationOnce(groupedSelect([{ week: monday, value: 1 }]))
      .mockImplementationOnce(groupedSelect([]));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/stats",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.stats).toEqual({
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
    });
    expect(body.weekly).toHaveLength(8);
    expect(body.weekly[7]).toEqual({ weekStart: monday.toISOString(), count: 3 });
    expect(body.weekly[0].count).toBe(0);
    expect(body.projects).toEqual([
      {
        workspaceId: linkedWorkspace.id,
        name: "ride-pack",
        slug: "ride-pack",
        summaries: 10,
        prs: 5,
        pushes: 3,
        versions: 2,
        summariesThisWeek: 4,
        reviewTimeSavedMinutes: 115,
      },
      {
        workspaceId: unlinkedWorkspace.id,
        name: "drafts",
        slug: "drafts",
        summaries: 0,
        prs: 0,
        pushes: 0,
        versions: 0,
        summariesThisWeek: 0,
        reviewTimeSavedMinutes: 0,
      },
    ]);
  });

  it("returns zeroed stats when the user has no linked repos", async () => {
    const select = vi.fn().mockImplementationOnce(flatSelect([unlinkedWorkspace]));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/stats",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.stats.summaries).toBe(0);
    expect(body.weekly).toHaveLength(8);
    expect(body.weekly.every((bucket: { count: number }) => bucket.count === 0)).toBe(true);
    expect(body.projects).toHaveLength(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("returns recent cross-workspace activity with composed titles", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(flatSelect([linkedWorkspace]))
      // recent: pr → push → version
      .mockImplementationOnce(
        feedSelect([
          {
            id: "00000000-0000-4000-8000-000000000b01",
            repo: "AntonyLajes/ride-pack",
            prNumber: 14,
            title: "feat(rides): classify ride pace",
            mergedAt: new Date("2026-06-03T12:00:00.000Z"),
          },
        ]),
      )
      .mockImplementationOnce(
        feedSelect([
          {
            id: "00000000-0000-4000-8000-000000000b02",
            repo: "AntonyLajes/ride-pack",
            title: "Push to main — 1 commit",
            pushedAt: new Date("2026-06-03T13:00:00.000Z"),
          },
        ]),
      )
      .mockImplementationOnce(
        feedSelect([
          {
            id: "00000000-0000-4000-8000-000000000b03",
            repo: "AntonyLajes/ride-pack",
            shortVersion: "1.3.1",
            buildVersion: "13",
            createdAt: new Date("2026-06-03T14:00:00.000Z"),
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
      url: "/api/me/activity?limit=2",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({
      id: "00000000-0000-4000-8000-000000000b03",
      type: "version",
      title: "v1.3.1 (13)",
      timestamp: "2026-06-03T14:00:00.000Z",
      workspaceName: "ride-pack",
      workspaceSlug: "ride-pack",
    });
    expect(body.items[1]).toMatchObject({
      type: "push",
      title: "Push to main — 1 commit",
    });
  });

  it("returns empty activity when no workspace has a repo", async () => {
    const select = vi.fn().mockImplementationOnce(flatSelect([unlinkedWorkspace]));
    const db = { select } as never;

    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/api/me/activity",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
    expect(select).toHaveBeenCalledTimes(1);
  });
});
