import { describe, expect, it, vi } from "vitest";

import { execute } from "@/changes/inspect-workspace-parity.js";
import type { Database } from "@/db/client.js";

const limitedQuery = (rows: unknown[]) => {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
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

describe("changes/inspect-workspace-parity execute", () => {
  it("should report missing source records and canonical totals", async () => {
    const db = buildDb([
      limitedQuery([{ sourceProvider: "github", repoFullName: "Acme/App" }]),
      whereQuery([{ id: "pr-1" }, { id: "pr-2" }]),
      whereQuery([{ id: "push-1" }]),
      whereQuery([{ id: "release-1" }, { id: "release-2" }]),
      joinedWhereQuery([
        { sourceRecordType: "pull_requests", sourceRecordId: "pr-1" },
        { sourceRecordType: "pull_requests", sourceRecordId: "pr-1" },
        { sourceRecordType: "pushes", sourceRecordId: "push-1" },
      ]),
      whereQuery([
        { id: "version-1", sourceReleaseId: "release-1" },
        { id: "version-open", sourceReleaseId: null },
      ]),
      whereQuery([
        { versionId: "version-1" },
        { versionId: null },
        { versionId: null },
      ]),
    ]);

    const result = await execute({
      db: db.db,
      workspaceId: "workspace-1",
      repo: " acme/app ",
    });

    expect(result).toEqual({
      workspaceId: "workspace-1",
      repo: "Acme/App",
      complete: false,
      sources: {
        pullRequests: {
          legacyCount: 2,
          projectedCount: 1,
          missingSourceRecordIds: ["pr-2"],
          coveragePercent: 50,
        },
        pushes: {
          legacyCount: 1,
          projectedCount: 1,
          missingSourceRecordIds: [],
          coveragePercent: 100,
        },
        releases: {
          legacyCount: 2,
          projectedCount: 1,
          missingSourceRecordIds: ["release-2"],
          coveragePercent: 50,
        },
      },
      canonical: {
        versions: 2,
        versionedChanges: 1,
        unversionedChanges: 2,
      },
    });
    expect(db.select).toHaveBeenCalledTimes(7);
  });

  it("should treat empty legacy sources as complete", async () => {
    const db = buildDb([
      limitedQuery([{ sourceProvider: "github", repoFullName: "acme/app" }]),
      whereQuery([]),
      whereQuery([]),
      whereQuery([]),
      joinedWhereQuery([]),
      whereQuery([]),
      whereQuery([]),
    ]);

    const result = await execute({
      db: db.db,
      workspaceId: "workspace-1",
      repo: "acme/app",
    });

    expect(result.complete).toBe(true);
    expect(result.sources.pullRequests.coveragePercent).toBe(100);
    expect(result.sources.pushes.coveragePercent).toBe(100);
    expect(result.sources.releases.coveragePercent).toBe(100);
  });

  it("should reject a workspace-to-repository mismatch before loading history", async () => {
    const db = buildDb([
      limitedQuery([{ sourceProvider: "github", repoFullName: "acme/other" }]),
    ]);

    await expect(
      execute({
        db: db.db,
        workspaceId: "workspace-1",
        repo: "acme/app",
      }),
    ).rejects.toThrow("Workspace repository mismatch");
    expect(db.select).toHaveBeenCalledOnce();
  });
});
