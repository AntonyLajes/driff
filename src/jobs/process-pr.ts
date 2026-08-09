import type { PullRequestProjector } from "@/changes/project-pull-request.js";
import { and, eq } from "drizzle-orm";
import type { Destination } from "@/destinations/destination.js";
import { publishBestEffort } from "@/destinations/optional-destination.js";
import type { Database } from "@/db/client.js";
import { pullRequestsTable } from "@/db/schema.js";
import type { Summarizer } from "@/llm/summarizer.js";
import { recordLlmUsage } from "@/llm/usage.js";
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
  canonicalProjection?: {
    projector: PullRequestProjector;
    workspaceId: string;
  };
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

      const existing = await input.db
        .select({ id: pullRequestsTable.id })
        .from(pullRequestsTable)
        .where(
          and(
            eq(pullRequestsTable.repo, jobPayload.repo),
            eq(pullRequestsTable.prNumber, jobPayload.prNumber),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        return;
      }

      const pullRequest = await input.source.fetchPullRequest(
        jobPayload.repo,
        jobPayload.prNumber,
      );
      const summary = await input.summarizer.summarizePR({ pullRequest });
      const publishResult = await publishBestEffort("publishPR", () =>
        input.destination.publishPR({
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
        }),
      );

      const sourceRecordId = await dbUpsertPullRequest({
        db: input.db,
        pullRequest,
        summary,
        notionPageId: publishResult.pageId,
        promptVersion: input.promptVersion,
      });

      if (input.canonicalProjection !== undefined) {
        await input.canonicalProjection.projector.project({
          workspaceId: input.canonicalProjection.workspaceId,
          sourceRecordId,
          pullRequest,
          summary,
          promptVersion: input.promptVersion,
        });
      }

      await recordLlmUsage({
        db: input.db,
        repo: pullRequest.repo,
        jobType: "process_pr",
        usage: summary.usage,
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
}: DbUpsertPullRequestInput): Promise<string> => {
  /* Diff stats aggregated from the PR files listing. */
  const additions = pullRequest.files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = pullRequest.files.reduce((sum, f) => sum + f.deletions, 0);
  const changedFiles = pullRequest.files.length;

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
    additions,
    deletions,
    changedFiles,
    notionPageId,
    promptVersion,
    updatedAt: new Date(),
  };

  const rows = await db
    .insert(pullRequestsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [pullRequestsTable.repo, pullRequestsTable.prNumber],
      set: values,
    })
    .returning({ id: pullRequestsTable.id });

  const row = rows[0];
  if (row === undefined) {
    throw new Error("Pull request upsert did not return a source record id.");
  }
  return row.id;
};
