import { describe, expect, it, vi } from "vitest";

import { execute } from "@/destinations/notion/notion-destination.js";
import type { PRSummary, ReleaseNotesSummary } from "@/destinations/destination.js";

const summary: PRSummary = {
  repo: "acme/mobile-app",
  prNumber: 10,
  title: "feat: add checkout improvements",
  author: "octocat",
  mergedAt: new Date("2026-04-25T19:00:00Z"),
  summaryUserFacing: "Checkout is faster and clearer.",
  summaryTechnical: "Refactors payment service and route handlers.",
  category: "feature",
  area: "checkout",
  prUrl: "https://github.com/acme/mobile-app/pull/10",
};

describe("destinations/notion/notion-destination execute", () => {
  it("should publish page with mapped properties and return page id", async () => {
    const create = vi.fn<(input: unknown) => Promise<{ id: string }>>(async () => ({
      id: "notion-page-1",
    }));
    const destination = execute({
      token: "notion-token",
      databaseId: "database-id",
      notionClientFactory: () => ({
        pages: { create },
      }),
    });

    const result = await destination.publishPR(summary);

    expect(result).toEqual({ pageId: "notion-page-1" });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: { database_id: "database-id" },
        properties: expect.objectContaining({
          Title: expect.any(Object),
          Repo: expect.any(Object),
          "PR Number": { number: 10 },
          Author: expect.any(Object),
          "Merged At": expect.any(Object),
          Category: { select: { name: "feature" } },
          URL: { url: "https://github.com/acme/mobile-app/pull/10" },
        }),
        children: expect.any(Array),
      }),
    );
  });

  it("should publish page with empty area rich text when area is null", async () => {
    const create = vi.fn<(input: unknown) => Promise<{ id: string }>>(async () => ({
      id: "notion-page-2",
    }));
    const destination = execute({
      token: "notion-token",
      databaseId: "database-id",
      notionClientFactory: () => ({
        pages: { create },
      }),
    });

    await destination.publishPR({
      ...summary,
      area: null,
    });

    const createInput = create.mock.calls[0]?.[0] as unknown as {
      properties: { Area: { rich_text: unknown[] } };
    };
    expect(createInput.properties.Area.rich_text).toEqual([]);
  });

  it("should throw when databaseId is missing", () => {
    expect(() =>
      execute({
        token: "notion-token",
        notionClientFactory: () => ({
          pages: { create: vi.fn(async () => ({ id: "x" })) },
        }),
      }),
    ).toThrow(/database id is not configured/i);
  });

  it("should create default notion client when factory is not provided", () => {
    const destination = execute({
      token: "notion-token",
      databaseId: "database-id",
    });

    expect(destination.publishPR).toBeTypeOf("function");
  });

  it("should publish release page to releases database", async () => {
    const create = vi.fn<(input: unknown) => Promise<{ id: string }>>(async () => ({
      id: "release-page-1",
    }));
    const releaseSummary: ReleaseNotesSummary = {
      title: "2.0.0 (50)",
      repo: "acme/ios",
      branch: "develop",
      newVersionKey: "2.0.0+50",
      previousVersionKey: "1.9.0+49",
      shortVersion: "2.0.0",
      buildVersion: "50",
      compareUrl: "https://github.com/acme/ios/compare/1.9...2.0",
      prNumbers: [10, 11],
      changelog: "Better performance and onboarding polish.",
      sections: [{ label: "Fixed", items: ["Crash on login."] }],
    };
    const destination = execute({
      token: "notion-token",
      databaseId: "pr-db",
      releasesDatabaseId: "rel-db",
      notionClientFactory: () => ({
        pages: { create },
      }),
    });

    const result = await destination.publishRelease(releaseSummary);

    expect(result).toEqual({ pageId: "release-page-1" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: { database_id: "rel-db" },
        properties: expect.objectContaining({
          Title: expect.any(Object),
          Version: expect.any(Object),
        }),
      }),
    );
  });
});
