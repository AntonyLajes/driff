import { describe, expect, it, vi } from "vitest";

import { execute } from "@/lineages/backfill-workspace.js";

const candidates = [
  {
    changeId: "change-existing",
    title: "Existing change",
    category: "feature",
    areaId: "area-home",
    areaSlug: "home",
    filePaths: ["src/home.tsx"],
    alreadyProjected: true,
  },
  {
    changeId: "change-ready",
    title: "Improve Home quick actions",
    category: "feature",
    areaId: "area-home",
    areaSlug: "home",
    filePaths: ["src/home.tsx"],
    alreadyProjected: false,
  },
  {
    changeId: "change-no-area",
    title: "Update dependencies",
    category: "chore",
    areaId: null,
    areaSlug: null,
    filePaths: ["package.json"],
    alreadyProjected: false,
  },
];

describe("lineages/backfill-workspace", () => {
  it("should default to a read-only report", async () => {
    const projector = vi.fn();

    const result = await execute({
      db: {} as never,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      candidateLoader: vi.fn(async () => candidates),
      projector,
    });

    expect(result).toEqual({
      mode: "dry_run",
      candidates: 3,
      alreadyProjected: 1,
      ready: 1,
      projected: 0,
      linkedExisting: 0,
      created: 0,
      skipped: [{ changeId: "change-no-area", reason: "missing_area" }],
    });
    expect(projector).not.toHaveBeenCalled();
  });

  it("should project only unassigned changes when apply is explicit", async () => {
    const projector = vi.fn(async () => ({
      kind: "projected" as const,
      lineageId: "lineage-home",
      lineageKey: "home-quick-actions",
      relationType: "modified" as const,
      matchedExisting: true,
      matchScore: 100,
    }));

    const result = await execute({
      db: {} as never,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      apply: true,
      candidateLoader: vi.fn(async () => candidates),
      projector,
    });

    expect(result).toEqual(
      expect.objectContaining({
        mode: "apply",
        ready: 1,
        projected: 1,
        linkedExisting: 1,
        created: 0,
      }),
    );
    expect(projector).toHaveBeenCalledTimes(1);
    expect(projector).toHaveBeenCalledWith(
      expect.objectContaining({
        changeId: "change-ready",
        areaSlug: "home",
        filePaths: ["src/home.tsx"],
      }),
    );
  });

  it("should report changes that cannot produce a stable identity", async () => {
    const projector = vi.fn(async () => ({
      kind: "unassigned" as const,
      reason: "insufficient_identity" as const,
    }));

    const result = await execute({
      db: {} as never,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      apply: true,
      candidateLoader: vi.fn(async () => [candidates[1]!]),
      projector,
    });

    expect(result.projected).toBe(0);
    expect(result.skipped).toEqual([
      { changeId: "change-ready", reason: "insufficient_identity" },
    ]);
  });
});
