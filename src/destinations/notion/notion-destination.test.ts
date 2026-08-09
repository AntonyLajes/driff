import { describe, expect, it, vi } from "vitest";

import { execute } from "@/destinations/notion/notion-destination.js";
import type {
  PRSummary,
  PushSummary,
  ReleaseNotesSummary,
} from "@/destinations/destination.js";

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

describe("destinations/notion/notion-destination execute", () => {
  it("should publish page with mapped properties and return page id", async () => {
    const create = vi.fn<(input: unknown) => Promise<{ id: string }>>(
      async () => ({
        id: "notion-page-1",
      }),
    );
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
    const create = vi.fn<(input: unknown) => Promise<{ id: string }>>(
      async () => ({
        id: "notion-page-2",
      }),
    );
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

  it("should skip publishing a PR when its database is not configured", async () => {
    const create = vi.fn(async () => ({ id: "x" }));
    const destination = execute({
      token: "notion-token",
      notionClientFactory: () => ({
        pages: { create },
      }),
    });

    const result = await destination.publishPR(summary);

    expect(result).toEqual({ pageId: "" });
    expect(create).not.toHaveBeenCalled();
  });

  it("should throw when token is missing", () => {
    expect(() =>
      execute({
        databaseId: "db-1",
        notionClientFactory: () => ({ pages: { create: vi.fn() } }),
      }),
    ).toThrow(/token is not configured/i);
  });

  it("should create default notion client when factory is not provided", () => {
    const destination = execute({
      token: "notion-token",
      databaseId: "database-id",
    });

    expect(destination.publishPR).toBeTypeOf("function");
  });

  it("should publish release page to releases database", async () => {
    const create = vi.fn<(input: unknown) => Promise<{ id: string }>>(
      async () => ({
        id: "release-page-1",
      }),
    );
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
          "Driff Key": {
            rich_text: [
              {
                type: "text",
                text: { content: "github:acme/ios:release:2.0.0+50" },
              },
            ],
          },
        }),
      }),
    );
  });

  it("should update an existing release page instead of creating a duplicate", async () => {
    const create = vi.fn(async () => ({ id: "unexpected" }));
    const update = vi.fn(async () => ({}));
    const updateMarkdown = vi.fn(async () => ({}));
    const query = vi.fn(async () => ({
      results: [{ id: "release-page-existing" }],
    }));
    const destination = execute({
      token: "notion-token",
      releasesDatabaseId: "rel-db",
      notionClientFactory: () => ({
        databases: {
          retrieve: vi.fn(async () => ({ data_sources: [{ id: "rel-ds" }] })),
        },
        dataSources: {
          retrieve: vi.fn(async () => ({
            properties: Object.fromEntries(
              [
                "Driff Key",
                "Repo",
                "Branch",
                "Version",
                "Short Version",
                "Build",
                "Previous Version",
                "URL",
                "PR Numbers",
              ].map((name) => [name, {}]),
            ),
          })),
          update: vi.fn(async () => ({})),
          query,
        },
        pages: { create, update, updateMarkdown },
      }),
    });

    await expect(destination.publishRelease(releaseSummary)).resolves.toEqual({
      pageId: "release-page-existing",
    });
    expect(create).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        page_id: "release-page-existing",
        properties: expect.objectContaining({ Version: expect.any(Object) }),
      }),
    );
    expect(updateMarkdown).toHaveBeenCalledWith({
      page_id: "release-page-existing",
      type: "replace_content",
      replace_content: {
        new_str:
          "## Changelog\n\nBetter performance and onboarding polish.\n\n## Fixed\n- Crash on login.",
        allow_deleting_content: true,
      },
    });
  });

  it("should adopt a legacy release page when its Driff key is missing", async () => {
    const create = vi.fn(async () => ({ id: "unexpected" }));
    const update = vi.fn(async () => ({}));
    const updateMarkdown = vi.fn(async () => ({}));
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [{ id: "legacy-release-page" }] });
    const destination = execute({
      token: "notion-token",
      releasesDatabaseId: "rel-db",
      notionClientFactory: () => ({
        databases: {
          retrieve: vi.fn(async () => ({ data_sources: [{ id: "rel-ds" }] })),
        },
        dataSources: {
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({})),
          query,
        },
        pages: { create, update, updateMarkdown },
      }),
    });

    const result = await destination.publishRelease(releaseSummary);

    expect(result).toEqual({ pageId: "legacy-release-page" });
    expect(create).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        filter: {
          and: [
            { property: "Repo", rich_text: { equals: "acme/ios" } },
            {
              property: "Version",
              rich_text: { equals: "2.0.0+50" },
            },
          ],
        },
      }),
    );
  });

  it("should skip release and push publishing when their databases are not configured", async () => {
    const create = vi.fn(async () => ({ id: "x" }));
    const destination = execute({
      token: "notion-token",
      notionClientFactory: () => ({ pages: { create } }),
    });
    const releaseSummary: ReleaseNotesSummary = {
      title: "2.0.0 (50)",
      repo: "acme/ios",
      branch: "main",
      newVersionKey: "2.0.0+50",
      previousVersionKey: "1.9.0+49",
      shortVersion: "2.0.0",
      buildVersion: "50",
      compareUrl: "https://github.com/acme/ios/compare/1.9...2.0",
      prNumbers: [10],
      changelog: "Faster checkout.",
      sections: [],
    };
    const pushSummary: PushSummary = {
      repo: "acme/ios",
      branch: "main",
      beforeSha: "before",
      afterSha: "after",
      pusher: "octocat",
      pushedAt: new Date("2026-01-01T00:00:00.000Z"),
      title: "Improve checkout",
      summaryUserFacing: "Checkout is faster.",
      summaryTechnical: "Optimizes the checkout query.",
      category: "feature",
      area: "checkout",
      compareUrl: "https://github.com/acme/ios/compare/before...after",
      commitCount: 1,
      prNumbers: [],
    };

    await expect(destination.publishRelease(releaseSummary)).resolves.toEqual({
      pageId: "",
    });
    await expect(destination.publishPush(pushSummary)).resolves.toEqual({
      pageId: "",
    });
    expect(create).not.toHaveBeenCalled();
  });
});
