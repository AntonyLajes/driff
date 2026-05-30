import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client.js";
import { execute } from "@/jobs/process-push.js";
import type { PushContext } from "@/sources/github/gather-push-context.js";

vi.mock("@/sources/github/gather-push-context.js", () => ({
  execute: vi.fn(),
}));

import { execute as gatherPushContext } from "@/sources/github/gather-push-context.js";

const mockedGather = vi.mocked(gatherPushContext);

const buildContext = (overrides: Partial<PushContext> = {}): PushContext => ({
  compareCommits: [{ sha: "b".repeat(40), message: "fix: hotfix login" }],
  commitMessages: ["fix: hotfix login"],
  prNumbers: [],
  totalCommits: 1,
  compareUrl: "https://github.com/acme/app/compare/aaa...bbb",
  fileChangeSummary: "modified: src/login.ts",
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
