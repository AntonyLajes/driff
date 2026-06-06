import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client.js";
import { execute } from "@/jobs/process-push.js";
import type { PushContext } from "@/sources/github/gather-push-context.js";

vi.mock("@/sources/github/gather-push-context.js", () => ({
  execute: vi.fn(),
}));
vi.mock("@/jobs/push-dedup.js", () => ({
  findPushOverlap: vi.fn(async () => ({ skip: false, reason: null })),
}));

import { execute as gatherPushContext } from "@/sources/github/gather-push-context.js";
import { findPushOverlap } from "@/jobs/push-dedup.js";

const mockedGather = vi.mocked(gatherPushContext);
const mockedOverlap = vi.mocked(findPushOverlap);

const buildContext = (overrides: Partial<PushContext> = {}): PushContext => ({
  compareCommits: [{ sha: "b".repeat(40), message: "fix: hotfix login" }],
  commitMessages: ["fix: hotfix login"],
  prNumbers: [],
  totalCommits: 1,
  compareUrl: "https://github.com/acme/app/compare/aaa...bbb",
  fileChangeSummary: "modified: src/login.ts",
  additions: 214,
  deletions: 96,
  changedFiles: 9,
  diff: "diff --git a/src/login.ts b/src/login.ts",
  ...overrides,
});

const buildDbMock = (existingRows: Array<{ id: string }> = []) => {
  const limit = vi.fn(async () => existingRows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  const onConflictDoNothing = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));

  const db = { select, insert } as unknown as Database;
  return { db, select, insert, values, onConflictDoNothing };
};

const buildDeps = (dbMock: ReturnType<typeof buildDbMock>) => {
  const summarizePush = vi.fn(async () => ({
    title: "Hotfix login crash",
    summaryUserFacing: "Fixes a login crash.",
    summaryTechnical: "Guards a null session.",
    category: "bugfix" as const,
    area: "login",
    usage: { model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 50 },
  }));
  const publishPush = vi.fn(async () => ({ pageId: "notion-push-1" }));
  return {
    db: dbMock.db,
    appId: "app",
    privateKey: "key",
    pushSummarizer: { summarizePush, prompt: "p" },
    destination: { publishPR: vi.fn(), publishRelease: vi.fn(), publishPush },
    promptVersion: 1,
    summarizePush,
    publishPush,
  };
};

const payload = {
  repo: "acme/app",
  beforeSha: "a".repeat(40),
  afterSha: "b".repeat(40),
  branch: "main",
  pusher: "octocat",
  pushedAt: "2026-05-29T12:00:00Z",
};

describe("jobs/process-push execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedOverlap.mockResolvedValue({ skip: false, reason: null });
  });

  it("summarizes a push, publishes it, and inserts a row", async () => {
    mockedGather.mockResolvedValue(buildContext());
    const dbMock = buildDbMock();
    const deps = buildDeps(dbMock);
    const handler = execute(deps);

    await handler.execute(payload);

    expect(deps.summarizePush).toHaveBeenCalledOnce();
    expect(deps.publishPush).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "acme/app",
        branch: "main",
        afterSha: "b".repeat(40),
        pusher: "octocat",
        commitCount: 1,
        category: "bugfix",
      }),
    );
    expect(dbMock.values).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "acme/app",
        afterSha: "b".repeat(40),
        notionPageId: "notion-push-1",
        promptVersion: 1,
        additions: 214,
        deletions: 96,
        changedFiles: 9,
      }),
    );
    expect(dbMock.onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it("is idempotent: skips when a push row already exists for repo+afterSha", async () => {
    const dbMock = buildDbMock([{ id: "existing" }]);
    const deps = buildDeps(dbMock);
    const handler = execute(deps);

    await handler.execute(payload);

    expect(mockedGather).not.toHaveBeenCalled();
    expect(deps.publishPush).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("skips publishing when the push overlaps a PR merge / release", async () => {
    mockedGather.mockResolvedValue(buildContext({ prNumbers: [7] }));
    mockedOverlap.mockResolvedValue({ skip: true, reason: "pr_merge_push" });
    const dbMock = buildDbMock();
    const deps = buildDeps(dbMock);
    const handler = execute(deps);

    await handler.execute(payload);

    expect(mockedOverlap).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "acme/app", afterSha: "b".repeat(40), prNumbers: [7] }),
    );
    expect(deps.summarizePush).not.toHaveBeenCalled();
    expect(deps.publishPush).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("skips when the compare range has no commits", async () => {
    mockedGather.mockResolvedValue(buildContext({ compareCommits: [], totalCommits: 0 }));
    const dbMock = buildDbMock();
    const deps = buildDeps(dbMock);
    const handler = execute(deps);

    await handler.execute(payload);

    expect(deps.publishPush).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("throws when the payload is invalid", async () => {
    const dbMock = buildDbMock();
    const handler = execute(buildDeps(dbMock));

    await expect(
      handler.execute({ repo: "", beforeSha: "a", afterSha: "b", branch: "main" }),
    ).rejects.toThrow(/Invalid process_push payload/);
  });
});
