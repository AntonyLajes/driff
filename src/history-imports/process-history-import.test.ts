import { describe, expect, it, vi } from "vitest";

import type { HistoryImportRepository } from "@/history-imports/history-import-repository.js";
import { execute } from "@/history-imports/process-history-import.js";

const IMPORT_ID = "00000000-0000-4000-8000-000000000111";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000222";

const record = {
  id: IMPORT_ID,
  workspaceId: WORKSPACE_ID,
  requestedByUserId: "00000000-0000-4000-8000-000000000333",
  status: "pending" as const,
  periodMonths: 12,
  maxPullRequests: 100,
  totalItems: 0,
  processedItems: 0,
  failedItems: 0,
  completedPrNumbers: [1],
  completedSourceKeys: ["pr:1"],
  failures: [],
  truncated: false,
  cancelRequested: false,
  lastError: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date("2026-08-09T00:00:00.000Z"),
  updatedAt: new Date("2026-08-09T00:00:00.000Z"),
};

const repository = () =>
  ({
    findById: vi.fn(async () => record),
    markRunning: vi.fn(async () => undefined),
    markDiscovered: vi.fn(async () => undefined),
    isCancellationRequested: vi.fn(async () => false),
    updateProgress: vi.fn(async () => undefined),
    markTerminal: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  }) as unknown as HistoryImportRepository;

const emptyHistoryDependencies = () => ({
  listRepositoryHistory: vi.fn(async () => ({
    defaultBranch: "main",
    releases: [],
    commits: [],
    truncated: false,
  })),
  processRelease: vi.fn(async () => undefined),
  processPush: vi.fn(async () => undefined),
});

describe("history-imports/process-history-import", () => {
  it("should resume completed PRs and checkpoint each new item", async () => {
    const repo = repository();
    const processPullRequest = vi.fn(async () => undefined);
    const handler = execute({
      ...emptyHistoryDependencies(),
      repository: repo,
      listMergedPullRequests: vi.fn(async () => ({
        pullRequests: [
          { prNumber: 1, mergedAt: new Date("2026-06-01T00:00:00.000Z") },
          { prNumber: 2, mergedAt: new Date("2026-07-01T00:00:00.000Z") },
        ],
        truncated: false,
      })),
      processPullRequest,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    await handler.execute({
      importId: IMPORT_ID,
      workspaceId: WORKSPACE_ID,
      repo: "acme/mobile",
    });

    expect(processPullRequest).toHaveBeenCalledOnce();
    expect(processPullRequest).toHaveBeenCalledWith({
      repo: "acme/mobile",
      prNumber: 2,
    });
    expect(repo.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        completedPrNumbers: [1, 2],
        completedSourceKeys: ["pr:1", "pr:2"],
        failures: [],
      }),
    );
    expect(repo.markTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("should finish partial while preserving successful items", async () => {
    const repo = repository();
    const processPullRequest = vi.fn(
      async ({ prNumber }: { prNumber: number }) => {
        if (prNumber === 2) throw new Error("rate limited");
      },
    );
    const handler = execute({
      ...emptyHistoryDependencies(),
      repository: repo,
      listMergedPullRequests: vi.fn(async () => ({
        pullRequests: [
          { prNumber: 2, mergedAt: new Date() },
          { prNumber: 3, mergedAt: new Date() },
        ],
        truncated: true,
      })),
      processPullRequest,
    });

    await handler.execute({
      importId: IMPORT_ID,
      workspaceId: WORKSPACE_ID,
      repo: "acme/mobile",
    });

    expect(repo.updateProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        completedPrNumbers: [1, 3],
        failures: [
          {
            sourceKind: "pull_request",
            sourceKey: "pr:2",
            prNumber: 2,
            message: "rate limited",
          },
        ],
      }),
    );
    expect(repo.markTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ status: "partial" }),
    );
  });

  it("should cancel before processing the next item", async () => {
    const repo = repository();
    vi.mocked(repo.isCancellationRequested).mockResolvedValue(true);
    const processPullRequest = vi.fn(async () => undefined);
    const handler = execute({
      ...emptyHistoryDependencies(),
      repository: repo,
      listMergedPullRequests: vi.fn(async () => ({
        pullRequests: [{ prNumber: 2, mergedAt: new Date() }],
        truncated: false,
      })),
      processPullRequest,
    });

    await handler.execute({
      importId: IMPORT_ID,
      workspaceId: WORKSPACE_ID,
      repo: "acme/mobile",
    });

    expect(processPullRequest).not.toHaveBeenCalled();
    expect(repo.markTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("should persist discovery failures for a worker retry", async () => {
    const repo = repository();
    const handler = execute({
      ...emptyHistoryDependencies(),
      repository: repo,
      listMergedPullRequests: vi.fn(async () => {
        throw new Error("GitHub unavailable");
      }),
      processPullRequest: vi.fn(async () => undefined),
    });

    await expect(
      handler.execute({
        importId: IMPORT_ID,
        workspaceId: WORKSPACE_ID,
        repo: "acme/mobile",
      }),
    ).rejects.toThrow("GitHub unavailable");
    expect(repo.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ message: "GitHub unavailable" }),
    );
  });

  it("should reject invalid payloads and mismatched records", async () => {
    const repo = repository();
    const handler = execute({
      ...emptyHistoryDependencies(),
      repository: repo,
      listMergedPullRequests: vi.fn(),
      processPullRequest: vi.fn(),
    });

    await expect(handler.execute({ importId: "nope" })).rejects.toThrow(
      "Invalid import_history payload",
    );
    vi.mocked(repo.findById).mockResolvedValue(null);
    await expect(
      handler.execute({
        importId: IMPORT_ID,
        workspaceId: WORKSPACE_ID,
        repo: "acme/mobile",
      }),
    ).rejects.toThrow("not found for the requested workspace");
    vi.mocked(repo.findById).mockResolvedValue({
      ...record,
      workspaceId: "00000000-0000-4000-8000-000000000999",
    });
    await expect(
      handler.execute({
        importId: IMPORT_ID,
        workspaceId: WORKSPACE_ID,
        repo: "acme/mobile",
      }),
    ).rejects.toThrow("not found for the requested workspace");
  });

  it.each(["completed", "cancelled"] as const)(
    "should no-op imports already %s",
    async (status) => {
      const repo = repository();
      vi.mocked(repo.findById).mockResolvedValue({ ...record, status });
      const listMergedPullRequests = vi.fn();
      const handler = execute({
        ...emptyHistoryDependencies(),
        repository: repo,
        listMergedPullRequests,
        processPullRequest: vi.fn(),
      });

      await handler.execute({
        importId: IMPORT_ID,
        workspaceId: WORKSPACE_ID,
        repo: "acme/mobile",
      });

      expect(listMergedPullRequests).not.toHaveBeenCalled();
      expect(repo.markRunning).not.toHaveBeenCalled();
    },
  );

  it("should normalize non-Error item failures", async () => {
    const repo = repository();
    const handler = execute({
      ...emptyHistoryDependencies(),
      repository: repo,
      listMergedPullRequests: vi.fn(async () => ({
        pullRequests: [{ prNumber: 2, mergedAt: new Date() }],
        truncated: false,
      })),
      processPullRequest: vi.fn(async () => {
        throw "offline";
      }),
    });

    await handler.execute({
      importId: IMPORT_ID,
      workspaceId: WORKSPACE_ID,
      repo: "acme/mobile",
    });

    expect(repo.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        failures: [
          {
            sourceKind: "pull_request",
            sourceKey: "pr:2",
            prNumber: 2,
            message: "Unknown history import error.",
          },
        ],
      }),
    );
  });

  it("should process PRs, version tags and commits in canonical order", async () => {
    const repo = repository();
    const processPullRequest = vi.fn(async () => undefined);
    const processRelease = vi.fn(async () => undefined);
    const processPush = vi.fn(async () => undefined);
    const handler = execute({
      repository: repo,
      listMergedPullRequests: vi.fn(async () => ({
        pullRequests: [
          { prNumber: 9, mergedAt: new Date("2026-08-01T00:00:00.000Z") },
        ],
        truncated: false,
      })),
      listRepositoryHistory: vi.fn(async () => ({
        defaultBranch: "main",
        releases: [
          {
            sourceKey: "release:v1.0.0:c9",
            tagName: "v1.0.0",
            beforeSha: "c8",
            afterSha: "c9",
            releasedAt: new Date("2026-08-02T00:00:00.000Z"),
          },
        ],
        commits: [
          {
            sourceKey: "commit:c9",
            sha: "c9",
            beforeSha: "c8",
            committedAt: new Date("2026-08-02T00:00:00.000Z"),
            pusher: "octocat",
          },
        ],
        truncated: false,
      })),
      processPullRequest,
      processRelease,
      processPush,
    });

    await handler.execute({
      importId: IMPORT_ID,
      workspaceId: WORKSPACE_ID,
      repo: "acme/mobile",
    });

    expect(processPullRequest.mock.invocationCallOrder[0]).toBeLessThan(
      processRelease.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(processRelease.mock.invocationCallOrder[0]).toBeLessThan(
      processPush.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(repo.markDiscovered).toHaveBeenCalledWith(
      expect.objectContaining({ totalItems: 3 }),
    );
    expect(repo.updateProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        completedSourceKeys: ["pr:1", "pr:9", "release:v1.0.0:c9", "commit:c9"],
      }),
    );
  });
});
