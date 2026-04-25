import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client.js";
import { execute } from "@/jobs/process-pr.js";

const buildDbMock = () => {
  const onConflictDoUpdate = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));

  const db = {
    insert,
  } as unknown as Database;

  return { db, insert, onConflictDoUpdate, values };
};

describe("jobs/process-pr execute", () => {
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
      files: [],
    }));
    const summarizePR = vi.fn(async () => ({
      title: "Checkout updates",
      summaryUserFacing: "Users can check out faster.",
      summaryTechnical: "Adds checkout orchestration.",
      category: "feature" as const,
      area: "checkout",
    }));
    const publishPR = vi.fn(async () => ({ pageId: "notion-page-1" }));
    const handler = execute({
      db,
      promptVersion: 1,
      source: { fetchPullRequest },
      summarizer: { summarizePR, prompt: "prompt" },
      destination: { publishPR },
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
        repo: "acme/mobile-app",
        notionPageId: "notion-page-1",
        promptVersion: 1,
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
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
