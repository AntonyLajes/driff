import { describe, expect, it, vi } from "vitest";

import { execute } from "@/analytics/load-ai-usage.js";

const flatSelect = (rows: unknown[]) => () => ({
  from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
});

const groupedSelect = (rows: unknown[]) => () => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({ groupBy: vi.fn(async () => rows) })),
  })),
});

describe("analytics/load-ai-usage", () => {
  it("should aggregate metered usage by linked project", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(
        flatSelect([
          { id: "w1", name: "App", slug: "app", repo: "acme/app" },
          { id: "w2", name: "Web", slug: "web", repo: "acme/web" },
          { id: "w3", name: "Draft", slug: "draft", repo: null },
        ]),
      )
      .mockImplementationOnce(
        groupedSelect([
          { repo: "acme/app", calls: 2, inputTokens: 1200, outputTokens: 300 },
        ]),
      );

    await expect(
      execute({ db: { select } as never, teamId: "team-1" }),
    ).resolves.toEqual({
      calls: 2,
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      projects: [
        {
          workspaceId: "w1",
          name: "App",
          slug: "app",
          repo: "acme/app",
          calls: 2,
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
        },
        {
          workspaceId: "w2",
          name: "Web",
          slug: "web",
          repo: "acme/web",
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      ],
    });
  });

  it("should avoid the usage scan when no repository is linked", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(
        flatSelect([{ id: "w1", name: "Draft", slug: "draft", repo: null }]),
      );

    await expect(
      execute({ db: { select } as never, teamId: "team-1" }),
    ).resolves.toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      projects: [],
    });
    expect(select).toHaveBeenCalledOnce();
  });
});
