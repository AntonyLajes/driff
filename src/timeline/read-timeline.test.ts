import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client.js";
import { execute } from "@/timeline/read-timeline.js";

const pagedQuery = (rows: unknown[]) => {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  return { query: { from }, limit };
};

const orderedQuery = (rows: unknown[]) => {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  return { from };
};

const whereQuery = (rows: unknown[]) => {
  const where = vi.fn(async () => rows);
  const from = vi.fn(() => ({ where }));
  return { from };
};

const joinedWhereQuery = (rows: unknown[]) => {
  const where = vi.fn(async () => rows);
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  return { from };
};

const buildDb = (queries: unknown[]) => {
  const select = vi.fn();
  for (const query of queries) {
    select.mockReturnValueOnce(query);
  }
  return { db: { select } as unknown as Database, select };
};

const version = (id: string, releasedAt: string) => ({
  id,
  displayVersion: id === "version-2" ? "2.0.0" : "1.0.0",
  normalizedVersion: id === "version-2" ? "2.0.0+2" : "1.0.0+1",
  buildVersion: id === "version-2" ? "2" : "1",
  title: `Release ${id}`,
  changelog: `Changelog ${id}`,
  sections: [{ label: "Mudanças", items: [id] }],
  sourceUrl: `https://github.com/acme/app/compare/${id}`,
  previousVersionId: id === "version-2" ? "version-1" : null,
  beforeSha: "a".repeat(40),
  headSha: "b".repeat(40),
  releasedAt: new Date(releasedAt),
});

const change = (id: string, versionId: string | null, occurredAt: string) => ({
  id,
  versionId,
  title: `Change ${id}`,
  summaryExecutive: `Executive ${id}`,
  summaryTechnical: `Technical ${id}`,
  category: "feature",
  confidence: 92,
  firstOccurredAt: new Date(occurredAt),
  lastOccurredAt: new Date(occurredAt),
});

describe("timeline/read-timeline execute", () => {
  it("should group versions and in-development changes with their relations", async () => {
    const versionsPage = pagedQuery([
      version("version-2", "2026-08-08T12:00:00.000Z"),
      version("version-1", "2026-08-01T12:00:00.000Z"),
      version("version-extra", "2026-07-01T12:00:00.000Z"),
    ]);
    const versionedChange = change(
      "change-released",
      "version-2",
      "2026-08-08T11:00:00.000Z",
    );
    const openChange = change("change-open", null, "2026-08-09T11:00:00.000Z");
    const db = buildDb([
      versionsPage.query,
      orderedQuery([versionedChange]),
      pagedQuery([openChange]).query,
      whereQuery([
        {
          changeId: "change-released",
          externalIdentity: "github:octocat",
          displayName: "Octocat",
          role: "pr_author",
          sourceUrl: "https://github.com/octocat",
        },
        {
          changeId: "change-open",
          externalIdentity: "github:pusher",
          displayName: "Pusher",
          role: "pusher",
          sourceUrl: "https://github.com/pusher",
        },
      ]),
      joinedWhereQuery([
        {
          changeId: "change-released",
          id: "area-checkout",
          name: "Checkout",
          slug: "checkout",
          confidence: null,
          source: "ai",
        },
      ]),
      orderedQuery([
        {
          id: "evidence-pr",
          changeId: "change-released",
          kind: "pull_request",
          sourceKey: "github:acme/app:pull_request:42",
          externalId: "42",
          url: "https://github.com/acme/app/pull/42",
          sha: "b".repeat(40),
          path: null,
          occurredAt: new Date("2026-08-08T11:00:00.000Z"),
          metadata: { baseBranch: "main" },
        },
        {
          id: "evidence-compare",
          changeId: "change-open",
          kind: "compare",
          sourceKey: "github:acme/app:compare:a...b",
          externalId: "b".repeat(40),
          url: "https://github.com/acme/app/compare/a...b",
          sha: "b".repeat(40),
          path: null,
          occurredAt: new Date("2026-08-09T11:00:00.000Z"),
          metadata: { branch: "main" },
        },
      ]),
      joinedWhereQuery([
        {
          changeId: "change-released",
          id: "lineage-checkout",
          key: "checkout-payments",
          title: "Checkout payments",
          description: null,
          status: "active",
          source: "rule",
          confidence: 88,
          relationType: "introduced",
          assignmentSource: "rule",
          assignmentConfidence: 92,
          correctedAt: null,
        },
      ]),
    ]);

    const result = await execute({
      db: db.db,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      limit: 2,
    });

    expect(versionsPage.limit).toHaveBeenCalledWith(3);
    expect(result.pageInfo).toEqual({
      hasNextPage: true,
      nextCursor: {
        releasedAt: new Date("2026-08-01T12:00:00.000Z"),
        id: "version-1",
      },
    });
    expect(result.versions).toHaveLength(2);
    expect(result.versions[0]).toEqual(
      expect.objectContaining({
        id: "version-2",
        previousVersionId: "version-1",
        releasedAt: "2026-08-08T12:00:00.000Z",
        changes: [
          expect.objectContaining({
            id: "change-released",
            areas: [expect.objectContaining({ slug: "checkout" })],
            contributors: [expect.objectContaining({ role: "pr_author" })],
            evidence: [expect.objectContaining({ kind: "pull_request" })],
            lineages: [
              expect.objectContaining({
                id: "lineage-checkout",
                relationType: "introduced",
              }),
            ],
          }),
        ],
      }),
    );
    expect(result.inDevelopment).toEqual({
      hasMore: false,
      changes: [
        expect.objectContaining({
          id: "change-open",
          contributors: [expect.objectContaining({ role: "pusher" })],
          evidence: [expect.objectContaining({ kind: "compare" })],
        }),
      ],
    });
    expect(db.select).toHaveBeenCalledTimes(7);
  });

  it("should omit in-development changes on subsequent cursor pages", async () => {
    const versionsPage = pagedQuery([
      version("version-1", "2026-08-01T12:00:00.000Z"),
    ]);
    const db = buildDb([versionsPage.query, orderedQuery([])]);

    const result = await execute({
      db: db.db,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      limit: 100,
      cursor: {
        releasedAt: new Date("2026-08-08T12:00:00.000Z"),
        id: "version-2",
      },
    });

    expect(versionsPage.limit).toHaveBeenCalledWith(21);
    expect(result.inDevelopment).toBeNull();
    expect(result.pageInfo).toEqual({ hasNextPage: false, nextCursor: null });
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("should return an empty first page without loading relations", async () => {
    const db = buildDb([pagedQuery([]).query, pagedQuery([]).query]);

    const result = await execute({
      db: db.db,
      workspaceId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toEqual({
      versions: [],
      inDevelopment: { changes: [], hasMore: false },
      pageInfo: { hasNextPage: false, nextCursor: null },
    });
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("should bound large in-development histories and report more results", async () => {
    const openChanges = Array.from({ length: 51 }, (_, index) =>
      change(
        `change-${String(index).padStart(2, "0")}`,
        null,
        `2026-08-${String((index % 9) + 1).padStart(2, "0")}T11:00:00.000Z`,
      ),
    );
    const db = buildDb([
      pagedQuery([]).query,
      pagedQuery(openChanges).query,
      whereQuery([]),
      joinedWhereQuery([]),
      orderedQuery([]),
      joinedWhereQuery([]),
    ]);

    const result = await execute({
      db: db.db,
      workspaceId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.inDevelopment?.changes).toHaveLength(50);
    expect(result.inDevelopment?.hasMore).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(6);
  });

  it("should load one version detail without querying in-development changes", async () => {
    const versionRow = version("version-2", "2026-08-08T12:00:00.000Z");
    const releasedChange = change(
      "change-released",
      "version-2",
      "2026-08-08T11:00:00.000Z",
    );
    const versionsPage = pagedQuery([versionRow]);
    const db = buildDb([
      versionsPage.query,
      orderedQuery([releasedChange]),
      whereQuery([]),
      joinedWhereQuery([]),
      orderedQuery([]),
      joinedWhereQuery([]),
    ]);

    const result = await execute({
      db: db.db,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
    });

    expect(versionsPage.limit).toHaveBeenCalledWith(1);
    expect(result.versions).toEqual([
      expect.objectContaining({
        id: "version-2",
        changes: [expect.objectContaining({ id: "change-released" })],
      }),
    ]);
    expect(result.inDevelopment).toBeNull();
    expect(result.pageInfo).toEqual({
      hasNextPage: false,
      nextCursor: null,
    });
    expect(db.select).toHaveBeenCalledTimes(6);
  });

  it("should load two selected version snapshots in one relation pass", async () => {
    const versionsPage = pagedQuery([
      version("version-2", "2026-08-08T12:00:00.000Z"),
      version("version-1", "2026-08-01T12:00:00.000Z"),
    ]);
    const db = buildDb([
      versionsPage.query,
      orderedQuery([
        change("change-target", "version-2", "2026-08-08T11:00:00.000Z"),
        change("change-base", "version-1", "2026-08-01T11:00:00.000Z"),
      ]),
      whereQuery([]),
      joinedWhereQuery([]),
      orderedQuery([]),
      joinedWhereQuery([]),
    ]);

    const result = await execute({
      db: db.db,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      versionIds: [
        "22222222-2222-4222-8222-222222222221",
        "22222222-2222-4222-8222-222222222222",
      ],
    });

    expect(versionsPage.limit).toHaveBeenCalledWith(2);
    expect(result.versions).toEqual([
      expect.objectContaining({
        id: "version-2",
        changes: [expect.objectContaining({ id: "change-target" })],
      }),
      expect.objectContaining({
        id: "version-1",
        changes: [expect.objectContaining({ id: "change-base" })],
      }),
    ]);
    expect(result.inDevelopment).toBeNull();
    expect(result.pageInfo).toEqual({
      hasNextPage: false,
      nextCursor: null,
    });
    expect(db.select).toHaveBeenCalledTimes(6);
  });
});
