import { z } from "zod";

import type { HistoryImportFailure } from "@/db/schema.js";
import type { HistoryImportRepository } from "@/history-imports/history-import-repository.js";
import type { ListMergedPullRequestsResult } from "@/history-imports/list-merged-pull-requests.js";
import type { ListRepositoryHistoryResult } from "@/history-imports/list-repository-history.js";

const payloadSchema = z.object({
  importId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
});

export interface ExecuteInput {
  repository: HistoryImportRepository;
  listMergedPullRequests: (input: {
    repo: string;
    since: Date;
    maxPullRequests: number;
  }) => Promise<ListMergedPullRequestsResult>;
  listRepositoryHistory: (input: {
    repo: string;
    since: Date;
    maxItems: number;
  }) => Promise<ListRepositoryHistoryResult>;
  processPullRequest: (payload: {
    repo: string;
    prNumber: number;
  }) => Promise<void>;
  processRelease: (payload: {
    repo: string;
    beforeSha: string;
    afterSha: string;
    branch: string;
    releasedAt: string;
  }) => Promise<void>;
  processPush: (payload: {
    repo: string;
    beforeSha: string;
    afterSha: string;
    branch: string;
    pusher: string | null;
    pushedAt: string;
  }) => Promise<void>;
  now?: () => Date;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown history import error.";

const subtractMonths = (date: Date, months: number): Date => {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() - months);
  return result;
};

export const execute = (input: ExecuteInput) => ({
  execute: async (payload: Record<string, unknown>): Promise<void> => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Invalid import_history payload.", {
        cause: parsed.error,
      });
    }
    const historyImport = await input.repository.findById(parsed.data.importId);
    if (
      historyImport === null ||
      historyImport.workspaceId !== parsed.data.workspaceId
    ) {
      throw new Error(
        "History import was not found for the requested workspace.",
      );
    }
    if (
      historyImport.status === "completed" ||
      historyImport.status === "cancelled"
    )
      return;

    const now = input.now ?? (() => new Date());
    await input.repository.markRunning(historyImport.id, now());

    let pullRequestHistory: ListMergedPullRequestsResult;
    let repositoryHistory: ListRepositoryHistoryResult;
    try {
      const since = subtractMonths(now(), historyImport.periodMonths);
      [pullRequestHistory, repositoryHistory] = await Promise.all([
        input.listMergedPullRequests({
          repo: parsed.data.repo,
          since,
          maxPullRequests: historyImport.maxPullRequests,
        }),
        input.listRepositoryHistory({
          repo: parsed.data.repo,
          since,
          maxItems: historyImport.maxPullRequests,
        }),
      ]);
    } catch (error) {
      await input.repository.markFailed({
        id: historyImport.id,
        message: errorMessage(error),
        updatedAt: now(),
      });
      throw error;
    }

    await input.repository.markDiscovered({
      id: historyImport.id,
      totalItems:
        pullRequestHistory.pullRequests.length +
        repositoryHistory.releases.length +
        repositoryHistory.commits.length,
      truncated: pullRequestHistory.truncated || repositoryHistory.truncated,
      updatedAt: now(),
    });

    const completedPrNumbers = [...historyImport.completedPrNumbers];
    const completedSourceKeys = [
      ...new Set([
        ...historyImport.completedSourceKeys,
        ...completedPrNumbers.map((prNumber) => `pr:${prNumber}`),
      ]),
    ];
    const completed = new Set(completedSourceKeys);
    const failures: HistoryImportFailure[] = [];

    const processItem = async (item: {
      sourceKind: HistoryImportFailure["sourceKind"];
      sourceKey: string;
      prNumber?: number;
      run: () => Promise<void>;
    }): Promise<"continue" | "cancelled"> => {
      if (completed.has(item.sourceKey)) return "continue";
      if (await input.repository.isCancellationRequested(historyImport.id)) {
        await input.repository.markTerminal({
          id: historyImport.id,
          status: "cancelled",
          completedAt: now(),
        });
        return "cancelled";
      }
      try {
        await item.run();
        completed.add(item.sourceKey);
        completedSourceKeys.push(item.sourceKey);
        if (
          item.prNumber !== undefined &&
          !completedPrNumbers.includes(item.prNumber)
        ) {
          completedPrNumbers.push(item.prNumber);
        }
      } catch (error) {
        failures.push({
          sourceKind: item.sourceKind,
          sourceKey: item.sourceKey,
          message: errorMessage(error),
          ...(item.prNumber === undefined ? {} : { prNumber: item.prNumber }),
        });
      }
      await input.repository.updateProgress({
        id: historyImport.id,
        completedPrNumbers,
        completedSourceKeys,
        failures,
        updatedAt: now(),
      });
      return "continue";
    };

    for (const pullRequest of pullRequestHistory.pullRequests) {
      const result = await processItem({
        sourceKind: "pull_request",
        sourceKey: `pr:${pullRequest.prNumber}`,
        prNumber: pullRequest.prNumber,
        run: () =>
          input.processPullRequest({
            repo: parsed.data.repo,
            prNumber: pullRequest.prNumber,
          }),
      });
      if (result === "cancelled") return;
    }
    for (const release of repositoryHistory.releases) {
      const result = await processItem({
        sourceKind: "release",
        sourceKey: release.sourceKey,
        run: () =>
          input.processRelease({
            repo: parsed.data.repo,
            beforeSha: release.beforeSha,
            afterSha: release.afterSha,
            branch: repositoryHistory.defaultBranch,
            releasedAt: release.releasedAt.toISOString(),
          }),
      });
      if (result === "cancelled") return;
    }
    for (const commit of repositoryHistory.commits) {
      const result = await processItem({
        sourceKind: "commit",
        sourceKey: commit.sourceKey,
        run: () =>
          input.processPush({
            repo: parsed.data.repo,
            beforeSha: commit.beforeSha,
            afterSha: commit.sha,
            branch: repositoryHistory.defaultBranch,
            pusher: commit.pusher,
            pushedAt: commit.committedAt.toISOString(),
          }),
      });
      if (result === "cancelled") return;
    }

    await input.repository.markTerminal({
      id: historyImport.id,
      status: failures.length > 0 ? "partial" : "completed",
      completedAt: now(),
    });
  },
});
