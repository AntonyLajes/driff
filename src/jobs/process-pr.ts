import type { Destination } from "@/destinations/destination.js";
import type { Database } from "@/db/client.js";
import { pullRequestsTable } from "@/db/schema.js";
import type { Summarizer } from "@/llm/summarizer.js";
import type { Source } from "@/sources/source.js";

export interface ProcessPrJobPayload {
  repo: string;
  prNumber: number;
}

export interface ExecuteInput {
  db: Database;
  source: Source;
  summarizer: Summarizer;
  destination: Destination;
  promptVersion: number;
}

const parsePayload = (payload: Record<string, unknown>): ProcessPrJobPayload => {
  const repo = payload.repo;
  const prNumber = payload.prNumber;

  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error("Invalid process_pr payload: repo must be a non-empty string.");
  }
  if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("Invalid process_pr payload: prNumber must be a positive integer.");
  }

  return { repo, prNumber };
};

export const execute = (input: ExecuteInput) => {
  return {
    execute: async (payload: Record<string, unknown>): Promise<void> => {
      const jobPayload = parsePayload(payload);
      const pullRequest = await input.source.fetchPullRequest(
        jobPayload.repo,
        jobPayload.prNumber,
      );
      const summary = await input.summarizer.summarizePR({ pullRequest });
      const publishResult = await input.destination.publishPR({
        repo: pullRequest.repo,
        prNumber: pullRequest.prNumber,
        title: summary.title,
        author: pullRequest.author,
        mergedAt: pullRequest.mergedAt,
        summaryUserFacing: summary.summaryUserFacing,
        summaryTechnical: summary.summaryTechnical,
        category: summary.category,
        area: summary.area,
        prUrl: `https://github.com/${pullRequest.repo}/pull/${pullRequest.prNumber}`,
      });

      await dbUpsertPullRequest({
        db: input.db,
        pullRequest,
        summary,
        notionPageId: publishResult.pageId,
        promptVersion: input.promptVersion,
      });
    },
  };
};

interface DbUpsertPullRequestInput {
  db: Database;
  pullRequest: Awaited<ReturnType<Source["fetchPullRequest"]>>;
  summary: Awaited<ReturnType<Summarizer["summarizePR"]>>;
  notionPageId: string;
  promptVersion: number;
}

const dbUpsertPullRequest = async ({
  db,
  pullRequest,
  summary,
  notionPageId,
  promptVersion,
}: DbUpsertPullRequestInput): Promise<void> => {
  const values = {
    repo: pullRequest.repo,
    prNumber: pullRequest.prNumber,
    title: pullRequest.title,
    author: pullRequest.author,
    mergedAt: pullRequest.mergedAt,
    headSha: pullRequest.headSha,
    baseBranch: pullRequest.baseBranch,
    summaryUserFacing: summary.summaryUserFacing,
    summaryTechnical: summary.summaryTechnical,
    category: summary.category,
    area: summary.area,
    notionPageId,
    promptVersion,
    updatedAt: new Date(),
  };

  await db
    .insert(pullRequestsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [pullRequestsTable.repo, pullRequestsTable.prNumber],
      set: values,
    });
};
