import { describe, expect, it, vi } from "vitest";

import { execute } from "@/analytics/load-product-funnel.js";

const flatSelect = (rows: unknown[]) => () => ({
  from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
});

const groupedSelect = (rows: unknown[]) => () => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({ groupBy: vi.fn(async () => rows) })),
  })),
});

describe("analytics/load-product-funnel", () => {
  it("should aggregate first-value stages without reading interaction content", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(flatSelect([{ id: "w1" }, { id: "w2" }]))
      .mockImplementationOnce(groupedSelect([{ workspaceId: "w1" }]))
      .mockImplementationOnce(
        groupedSelect([
          {
            workspaceId: "w1",
            evidenceAnswers: 2,
            helpfulFeedback: 1,
            unhelpfulFeedback: 0,
          },
          {
            workspaceId: "w2",
            evidenceAnswers: 0,
            helpfulFeedback: 0,
            unhelpfulFeedback: 1,
          },
        ]),
      );

    await expect(
      execute({ db: { select } as never, teamId: "team-1", userId: "user-1", role: "owner" }),
    ).resolves.toEqual({
      connectedProjects: 2,
      historyReadyProjects: 1,
      askedProjects: 2,
      evidenceAnswerProjects: 1,
      helpfulFeedback: 1,
      unhelpfulFeedback: 1,
    });
  });

  it("should avoid aggregate scans when the team has no projects", async () => {
    const select = vi.fn().mockImplementationOnce(flatSelect([]));

    await expect(
      execute({ db: { select } as never, teamId: "team-1", userId: "user-1", role: "owner" }),
    ).resolves.toEqual({
      connectedProjects: 0,
      historyReadyProjects: 0,
      askedProjects: 0,
      evidenceAnswerProjects: 0,
      helpfulFeedback: 0,
      unhelpfulFeedback: 0,
    });
    expect(select).toHaveBeenCalledOnce();
  });
});
