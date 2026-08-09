import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client.js";
import { execute } from "@/jobs/process-pr.js";

const buildDbMock = (
  returnedRows: Array<{ id: string }> = [
    { id: "11111111-1111-4111-8111-111111111111" },
  ],
  existingRows: Array<{ id: string }> = [],
) => {
  const limit = vi.fn(async () => existingRows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const returning = vi.fn(async () => returnedRows);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));

  const db = {
    select,
    insert,
  } as unknown as Database;

  return {
    db,
    from,
    insert,
    limit,
    onConflictDoUpdate,
    returning,
    select,
    values,
    where,
  };
};

describe("jobs/process-pr execute", () => {
  it("skips a pull request that was already summarized", async () => {
    const { db, insert } = buildDbMock(undefined, [{ id: "existing-pr" }]);
    const fetchPullRequest = vi.fn();
    const summarizePR = vi.fn();
    const publishPR = vi.fn();
    const project = vi.fn();
    const handler = execute({
      db,
      promptVersion: 1,
      source: { fetchPullRequest },
      summarizer: { summarizePR, prompt: "prompt" },
      destination: { publishPR, publishRelease: vi.fn(), publishPush: vi.fn() },
      canonicalProjection: {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        projector: { project },
      },
    });

    await expect(
      handler.execute({ repo: "acme/mobile-app", prNumber: 100 }),
    ).resolves.toBeUndefined();

    expect(fetchPullRequest).not.toHaveBeenCalled();
    expect(summarizePR).not.toHaveBeenCalled();
    expect(publishPR).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
  });

  it("should process pr and upsert pull request", async () => {
    const { db, values, onConflictDoUpdate } = buildDbMock();
    const fetchPullRequest = vi.fn(async () => ({
      repo: "acme/mobile-app",
      prNumber: 100,
      title: "feat: checkout",
      body: "body",
      author: "octocat",
      mergedAt: new Date("2026-04-25T19:10:00Z"),
      headSha: "abc123",
      baseBranch: "main",
      diff: "diff",
      files: [
        { path: "src/a.ts", additions: 120, deletions: 30 },
        { path: "src/b.ts", additions: 80, deletions: 12 },
      ],
    }));
    const summarizePR = vi.fn(async () => ({
      title: "Checkout updates",
      summaryUserFacing: "Users can check out faster.",
      summaryTechnical: "Adds checkout orchestration.",
      category: "feature" as const,
      area: "checkout",
      usage: { model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 50 },
    }));
    const publishPR = vi.fn(async () => ({ pageId: "notion-page-1" }));
    const project = vi.fn(async () => undefined);
    const handler = execute({
      db,
      promptVersion: 1,
      source: { fetchPullRequest },
      summarizer: { summarizePR, prompt: "prompt" },
      destination: { publishPR, publishRelease: vi.fn(), publishPush: vi.fn() },
      canonicalProjection: {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        projector: { project },
      },
    });

    await handler.execute({
      repo: "acme/mobile-app",
      prNumber: 100,
    });

    expect(fetchPullRequest).toHaveBeenCalledWith("acme/mobile-app", 100);
    expect(summarizePR).toHaveBeenCalledOnce();
    expect(publishPR).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "acme/mobile-app",
        prNumber: 100,
        prUrl: "https://github.com/acme/mobile-app/pull/100",
      }),
    );
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        additions: 200,
        deletions: 42,
        changedFiles: 2,
        repo: "acme/mobile-app",
        notionPageId: "notion-page-1",
        promptVersion: 1,
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    expect(project).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sourceRecordId: "11111111-1111-4111-8111-111111111111",
        promptVersion: 1,
      }),
    );
  });

  it("persists the canonical summary when external delivery fails", async () => {
    const { db, values } = buildDbMock();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = execute({
      db,
      promptVersion: 1,
      source: {
        fetchPullRequest: vi.fn(async () => ({
          repo: "acme/mobile-app",
          prNumber: 101,
          title: "fix: checkout",
          body: null,
          author: "octocat",
          mergedAt: new Date("2026-04-25T19:10:00Z"),
          headSha: "def456",
          baseBranch: "main",
          diff: "diff",
          files: [],
        })),
      },
      summarizer: {
        summarizePR: vi.fn(async () => ({
          title: "Checkout fix",
          summaryUserFacing: "Checkout is stable again.",
          summaryTechnical: "Guards the checkout state.",
          category: "bugfix" as const,
          area: "checkout",
          usage: { model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 50 },
        })),
        prompt: "prompt",
      },
      destination: {
        publishPR: vi.fn(async () => {
          throw new Error("Notion unavailable");
        }),
        publishRelease: vi.fn(),
        publishPush: vi.fn(),
      },
    });

    await expect(
      handler.execute({ repo: "acme/mobile-app", prNumber: 101 }),
    ).resolves.toBeUndefined();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ notionPageId: "", prNumber: 101 }),
    );
    expect(warning).toHaveBeenCalledWith(
      "optional destination failed to publishPR:",
      expect.any(Error),
    );
  });

  it("removes configured file noise before summarization and persistence", async () => {
    const { db, values } = buildDbMock();
    const summarizePR = vi.fn(async ({ pullRequest }) => {
      expect(pullRequest.files).toEqual([
        { path: "src/home.ts", additions: 12, deletions: 2 },
      ]);
      expect(pullRequest.diff).not.toContain("package-lock.json");
      return {
        title: "Home update",
        summaryUserFacing: "Improves Home.",
        summaryTechnical: "Updates Home actions.",
        category: "feature" as const,
        area: "home",
        usage: { model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 50 },
      };
    });
    const handler = execute({
      db,
      promptVersion: 1,
      source: {
        fetchPullRequest: vi.fn(async () => ({
          repo: "acme/mobile-app",
          prNumber: 102,
          title: "feat: home",
          body: null,
          author: "octocat",
          mergedAt: new Date("2026-04-25T19:10:00Z"),
          headSha: "ghi789",
          baseBranch: "main",
          diff: [
            "diff --git a/package-lock.json b/package-lock.json\n+lock",
            "diff --git a/src/home.ts b/src/home.ts\n+feature",
          ].join("\n"),
          files: [
            { path: "package-lock.json", additions: 500, deletions: 100 },
            { path: "src/home.ts", additions: 12, deletions: 2 },
          ],
        })),
      },
      summarizer: { summarizePR, prompt: "prompt" },
      destination: {
        publishPR: vi.fn(async () => ({ pageId: "" })),
        publishRelease: vi.fn(),
        publishPush: vi.fn(),
      },
      contentFilter: {
        excludedPaths: ["package-lock.json"],
        excludedActors: [],
      },
    });

    await handler.execute({ repo: "acme/mobile-app", prNumber: 102 });

    expect(summarizePR).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ additions: 12, deletions: 2, changedFiles: 1 }),
    );
  });

  it("skips a pull request when its actor is excluded", async () => {
    const { db, insert } = buildDbMock();
    const summarizePR = vi.fn();
    const handler = execute({
      db,
      promptVersion: 1,
      source: {
        fetchPullRequest: vi.fn(async () => ({
          repo: "acme/mobile-app",
          prNumber: 103,
          title: "deps",
          body: null,
          author: "dependabot[bot]",
          mergedAt: new Date(),
          headSha: "bot",
          baseBranch: "main",
          diff: "diff",
          files: [{ path: "package.json", additions: 1, deletions: 1 }],
        })),
      },
      summarizer: { summarizePR, prompt: "prompt" },
      destination: {
        publishPR: vi.fn(),
        publishRelease: vi.fn(),
        publishPush: vi.fn(),
      },
      contentFilter: {
        excludedPaths: [],
        excludedActors: ["Dependabot[bot]"],
      },
    });

    await handler.execute({ repo: "acme/mobile-app", prNumber: 103 });

    expect(summarizePR).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("should fail before projection when the legacy upsert returns no source id", async () => {
    const { db } = buildDbMock([]);
    const project = vi.fn(async () => undefined);
    const handler = execute({
      db,
      promptVersion: 1,
      source: {
        fetchPullRequest: vi.fn(async () => ({
          repo: "acme/mobile-app",
          prNumber: 100,
          title: "feat: checkout",
          body: null,
          author: "octocat",
          mergedAt: new Date("2026-04-25T19:10:00Z"),
          headSha: "abc123",
          baseBranch: "main",
          diff: "diff",
          files: [],
        })),
      },
      summarizer: {
        summarizePR: vi.fn(async () => ({
          title: "Checkout updates",
          summaryUserFacing: "Users can check out faster.",
          summaryTechnical: "Adds checkout orchestration.",
          category: "feature" as const,
          area: "checkout",
          usage: {
            model: "claude-sonnet-4-6",
            inputTokens: 100,
            outputTokens: 50,
          },
        })),
        prompt: "prompt",
      },
      destination: {
        publishPR: vi.fn(async () => ({ pageId: "notion-page-1" })),
        publishRelease: vi.fn(),
        publishPush: vi.fn(),
      },
      canonicalProjection: {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        projector: { project },
      },
    });

    await expect(
      handler.execute({ repo: "acme/mobile-app", prNumber: 100 }),
    ).rejects.toThrow("Pull request upsert did not return a source record id.");
    expect(project).not.toHaveBeenCalled();
  });

  it("should throw when payload is invalid", async () => {
    const { db } = buildDbMock();
    const handler = execute({
      db,
      promptVersion: 1,
      source: {
        fetchPullRequest: vi.fn(async () => {
          throw new Error("not reached");
        }),
      },
      summarizer: {
        summarizePR: vi.fn(async () => {
          throw new Error("not reached");
        }),
        prompt: "prompt",
      },
      destination: {
        publishPR: vi.fn(async () => ({ pageId: "notion-page-1" })),
        publishRelease: vi.fn(),
        publishPush: vi.fn(),
      },
    });

    await expect(
      handler.execute({
        repo: "",
        prNumber: -1,
      }),
    ).rejects.toThrowError(/Invalid process_pr payload/);
  });
});
