import { z } from "zod";

import type { HistoryImportRepository } from "@/history-imports/history-import-repository.js";
import type { ListMergedPullRequestsResult } from "@/history-imports/list-merged-pull-requests.js";

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
  processPullRequest: (payload: {
    repo: string;
    prNumber: number;
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
    ) {
      return;
    }

    const now = input.now ?? (() => new Date());
    await input.repository.markRunning(historyImport.id, now());

    let discovered: ListMergedPullRequestsResult;
    try {
      discovered = await input.listMergedPullRequests({
        repo: parsed.data.repo,
        since: subtractMonths(now(), historyImport.periodMonths),
        maxPullRequests: historyImport.maxPullRequests,
      });
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
      totalItems: discovered.pullRequests.length,
      truncated: discovered.truncated,
      updatedAt: now(),
    });

    const completedPrNumbers = [...historyImport.completedPrNumbers];
    const completed = new Set(completedPrNumbers);
    const failures: Array<{ prNumber: number; message: string }> = [];

    for (const pullRequest of discovered.pullRequests) {
      if (completed.has(pullRequest.prNumber)) {
        continue;
      }
      if (await input.repository.isCancellationRequested(historyImport.id)) {
        await input.repository.markTerminal({
          id: historyImport.id,
          status: "cancelled",
          completedAt: now(),
        });
        return;
      }
      try {
        await input.processPullRequest({
          repo: parsed.data.repo,
          prNumber: pullRequest.prNumber,
        });
        completed.add(pullRequest.prNumber);
        completedPrNumbers.push(pullRequest.prNumber);
      } catch (error) {
        failures.push({
          prNumber: pullRequest.prNumber,
          message: errorMessage(error),
        });
      }
      await input.repository.updateProgress({
        id: historyImport.id,
        completedPrNumbers,
        failures,
        updatedAt: now(),
      });
    }

    await input.repository.markTerminal({
      id: historyImport.id,
      status: failures.length > 0 ? "partial" : "completed",
      completedAt: now(),
    });
  },
});
