import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client.js";
import { execute } from "@/lineages/read-workspace-lineages.js";

const pagedQuery = (rows: unknown[]) => {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  return { from };
};

const entryQuery = (rows: unknown[]) => {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const leftJoin = vi.fn(() => ({ where }));
  const innerJoin = vi.fn(() => ({ leftJoin }));
  const from = vi.fn(() => ({ innerJoin }));
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

const orderedQuery = (rows: unknown[]) => {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  return { from };
};

const buildDb = (queries: unknown[]) => {
  const select = vi.fn();
  for (const query of queries) select.mockReturnValueOnce(query);
  return { db: { select } as unknown as Database, select };
};

describe("lineages/read-workspace-lineages", () => {
  it("should return ordered evidence-backed feature histories", async () => {
    const db = buildDb([
      pagedQuery([
        {
          id: "lineage-home",
          key: "home-quick-actions",
          title: "Home quick actions",
          description: null,
          status: "active",
          source: "rule",
          confidence: 100,
          mergedIntoLineageId: null,
          createdAt: new Date("2026-08-01T10:00:00.000Z"),
          updatedAt: new Date("2026-08-08T10:00:00.000Z"),
        },
      ]),
      entryQuery([
        {
          lineageId: "lineage-home",
          relationType: "introduced",
          occurredAt: new Date("2026-08-01T10:00:00.000Z"),
          assignmentSource: "rule",
          assignmentConfidence: 90,
          correctedAt: null,
          changeId: "change-home",
          title: "Add Home quick actions",
          summaryExecutive: "Adds shortcuts.",
          summaryTechnical: "Adds pressable actions.",
          category: "feature",
          confidence: 95,
          firstOccurredAt: new Date("2026-08-01T10:00:00.000Z"),
          lastOccurredAt: new Date("2026-08-01T10:00:00.000Z"),
          versionId: "version-1",
          displayVersion: "1.3.3",
          buildVersion: "5",
          releasedAt: new Date("2026-08-01T12:00:00.000Z"),
        },
      ]),
      whereQuery([
        {
          changeId: "change-home",
          externalIdentity: "github:antony",
          displayName: "Antony",
          role: "pr_author",
          sourceUrl: "https://github.com/antony",
        },
      ]),
      joinedWhereQuery([
        {
          changeId: "change-home",
          id: "area-home",
          name: "Home",
          slug: "home",
        },
      ]),
      orderedQuery([
        {
          id: "evidence-pr",
          changeId: "change-home",
          kind: "pull_request",
          externalId: "16",
          url: "https://github.com/acme/app/pull/16",
          sha: "a".repeat(40),
          path: null,
          occurredAt: new Date("2026-08-01T10:00:00.000Z"),
        },
      ]),
    ]);

    const result = await execute({
      db: db.db,
      workspaceId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.lineages).toEqual([
      expect.objectContaining({
        id: "lineage-home",
        title: "Home quick actions",
        entries: [
          expect.objectContaining({
            relationType: "introduced",
            change: expect.objectContaining({
              title: "Add Home quick actions",
              version: expect.objectContaining({ displayVersion: "1.3.3" }),
              areas: [expect.objectContaining({ slug: "home" })],
              contributors: [expect.objectContaining({ displayName: "Antony" })],
              evidence: [expect.objectContaining({ kind: "pull_request" })],
            }),
          }),
        ],
      }),
    ]);
    expect(db.select).toHaveBeenCalledTimes(5);
  });

  it("should stop after the lineage query when no history exists", async () => {
    const db = buildDb([pagedQuery([])]);

    await expect(
      execute({
        db: db.db,
        workspaceId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toEqual({ lineages: [] });
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
