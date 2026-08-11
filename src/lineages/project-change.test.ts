import { describe, expect, it, vi } from "vitest";

import { execute } from "@/lineages/project-change.js";

const candidateQuery = (rows: unknown[]) => {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const innerJoinArea = vi.fn(() => ({ where }));
  const innerJoinChange = vi.fn(() => ({ innerJoin: innerJoinArea }));
  const innerJoinLineage = vi.fn(() => ({ innerJoin: innerJoinChange }));
  const from = vi.fn(() => ({ innerJoin: innerJoinLineage }));
  return { from };
};

const pathQuery = (rows: unknown[]) => {
  const where = vi.fn(async () => rows);
  const from = vi.fn(() => ({ where }));
  return { from };
};

const buildDb = (queries: unknown[]) => {
  const select = vi.fn();
  for (const query of queries) select.mockReturnValueOnce(query);
  return { db: { select } as never, select };
};

const baseInput = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  changeId: "22222222-2222-4222-8222-222222222222",
  title: "Improve touch feedback on Home quick action buttons",
  category: "feature",
  areaId: "33333333-3333-4333-8333-333333333333",
  areaSlug: "home",
  filePaths: ["src/screens/HomeScreen.tsx"],
};

describe("lineages/project-change", () => {
  it("should create an introduced lineage when no candidate exists", async () => {
    const db = buildDb([candidateQuery([])]);
    const membershipWriter = vi.fn(async () => ({
      lineageId: "new-lineage",
      lineageKey: "home-action-button-feedback-home",
    }));

    const result = await execute({
      ...baseInput,
      db: db.db,
      membershipWriter,
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "projected",
        relationType: "introduced",
        matchedExisting: false,
        matchScore: null,
      }),
    );
    expect(membershipWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        lineage: expect.objectContaining({ source: "rule", confidence: 70 }),
        relationType: "introduced",
        assignmentConfidence: 70,
      }),
    );
  });

  it("should attach a high-confidence component match as modified", async () => {
    const db = buildDb([
      candidateQuery([
        {
          lineageId: "existing-lineage",
          lineageKey: "home-action-button-home-quick",
          lineageTitle: "Home quick actions",
          lineageSource: "rule",
          lineageConfidence: 90,
          changeId: "previous-change",
          title: "Add quick action buttons to Home",
          category: "feature",
        },
      ]),
      pathQuery([
        {
          changeId: "previous-change",
          path: "src/screens/HomeScreen.tsx",
        },
      ]),
    ]);
    const membershipWriter = vi.fn(async () => ({
      lineageId: "existing-lineage",
      lineageKey: "home-action-button-home-quick",
    }));

    const result = await execute({
      ...baseInput,
      db: db.db,
      membershipWriter,
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "projected",
        lineageId: "existing-lineage",
        relationType: "modified",
        matchedExisting: true,
        matchScore: 100,
      }),
    );
    expect(membershipWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        lineage: expect.objectContaining({
          key: "home-action-button-home-quick",
          title: "Home quick actions",
        }),
        relationType: "modified",
        assignmentConfidence: 100,
      }),
    );
  });

  it("should keep a low-confidence change in a separate lineage", async () => {
    const db = buildDb([
      candidateQuery([
        {
          lineageId: "banner-lineage",
          lineageKey: "home-banner-carousel",
          lineageTitle: "Home banner",
          lineageSource: "human",
          lineageConfidence: 100,
          changeId: "banner-change",
          title: "Add promotional banner carousel",
          category: "feature",
        },
      ]),
      pathQuery([
        {
          changeId: "banner-change",
          path: "src/components/PromoCarousel.tsx",
        },
      ]),
    ]);
    const membershipWriter = vi.fn(async () => ({
      lineageId: "separate-lineage",
      lineageKey: "home-action-button-feedback-home",
    }));

    const result = await execute({
      ...baseInput,
      db: db.db,
      membershipWriter,
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "projected",
        lineageId: "separate-lineage",
        relationType: "introduced",
        matchedExisting: false,
      }),
    );
    expect(membershipWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        lineage: expect.not.objectContaining({ key: "home-banner-carousel" }),
      }),
    );
  });
});
