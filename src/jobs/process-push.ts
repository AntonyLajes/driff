import { and, eq } from "drizzle-orm";

import type { PushProjector } from "@/changes/project-push.js";
import type { Database } from "@/db/client.js";
import { pullRequestsTable, pushesTable } from "@/db/schema.js";
import type { Destination } from "@/destinations/destination.js";
import { publishBestEffort } from "@/destinations/optional-destination.js";
import type { PushSummarizer } from "@/llm/push-summarizer.js";
import { recordLlmUsage } from "@/llm/usage.js";
import { findPushOverlap } from "@/jobs/push-dedup.js";
import { execute as gatherPushContext } from "@/sources/github/gather-push-context.js";
import {
  filterHistoryDiff,
  filterHistoryFileSummary,
  isHistoryActorExcluded,
  isHistoryPathExcluded,
} from "@/config/history-content-filter.js";

export interface ProcessPushJobPayload {
  repo: string;
  beforeSha: string;
  afterSha: string;
  branch: string;
  pusher: string | null;
  pushedAt: Date;
}

export interface ExecuteInput {
  db: Database;
  appId: string;
  privateKey: string;
  pushSummarizer: PushSummarizer;
  destination: Destination;
  canonicalProjection?: {
    projector: PushProjector;
    workspaceId: string;
  };
  contentFilter?: {
    excludedPaths: readonly string[];
    excludedActors: readonly string[];
  };
  promptVersion: number;
}

const parsePayload = (
  payload: Record<string, unknown>,
): ProcessPushJobPayload => {
  const { repo, beforeSha, afterSha, branch, pusher, pushedAt } = payload;
  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error(
      "Invalid process_push payload: repo must be a non-empty string.",
    );
  }
  if (typeof beforeSha !== "string" || beforeSha.length === 0) {
    throw new Error(
      "Invalid process_push payload: beforeSha must be a non-empty string.",
    );
  }
  if (typeof afterSha !== "string" || afterSha.length === 0) {
    throw new Error(
      "Invalid process_push payload: afterSha must be a non-empty string.",
    );
  }
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error(
      "Invalid process_push payload: branch must be a non-empty string.",
    );
  }

  const pusherValue =
    typeof pusher === "string" && pusher.trim().length > 0
      ? pusher.trim()
      : null;
  let pushedAtValue = new Date();
  if (typeof pushedAt === "string" && pushedAt.length > 0) {
    const parsed = new Date(pushedAt);
    if (!Number.isNaN(parsed.getTime())) {
      pushedAtValue = parsed;
    }
  }

  return {
    repo,
    beforeSha,
    afterSha,
    branch,
    pusher: pusherValue,
    pushedAt: pushedAtValue,
  };
};

export const execute = (input: ExecuteInput) => {
  return {
    execute: async (payload: Record<string, unknown>): Promise<void> => {
      const job = parsePayload(payload);
      const excludedPaths = input.contentFilter?.excludedPaths ?? [];
      const excludedActors = input.contentFilter?.excludedActors ?? [];
      if (isHistoryActorExcluded(job.pusher, excludedActors)) {
        return;
      }

      const existing = await input.db
        .select({ id: pushesTable.id })
        .from(pushesTable)
        .where(
          and(
            eq(pushesTable.repo, job.repo),
            eq(pushesTable.afterSha, job.afterSha),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        return;
      }

      // A commit returned by the repository history endpoint can be exactly the
      // head commit of an already imported PR without GitHub exposing the PR
      // number in the compare payload. Catch that case before fetching the diff
      // or spending LLM tokens on a duplicate standalone-push summary.
      const existingPullRequest = await input.db
        .select({ id: pullRequestsTable.id })
        .from(pullRequestsTable)
        .where(
          and(
            eq(pullRequestsTable.repo, job.repo),
            eq(pullRequestsTable.headSha, job.afterSha),
          ),
        )
        .limit(1);
      if (existingPullRequest.length > 0) {
        console.log(
          `[process_push] skipped ${job.repo}@${job.afterSha.slice(0, 7)} (stored PR head)`,
        );
        return;
      }

      const gatheredContext = await gatherPushContext({
        appId: input.appId,
        privateKey: input.privateKey,
        repo: job.repo,
        beforeSha: job.beforeSha,
        afterSha: job.afterSha,
      });

      const includedFiles = gatheredContext.files?.filter(
        (file) => !isHistoryPathExcluded(file.path, excludedPaths),
      );
      if (
        gatheredContext.files !== undefined &&
        gatheredContext.files.length > 0 &&
        includedFiles?.length === 0
      ) {
        return;
      }
      const context = {
        ...gatheredContext,
        files: includedFiles,
        fileChangeSummary: filterHistoryFileSummary(
          gatheredContext.fileChangeSummary,
          excludedPaths,
        ),
        diff: filterHistoryDiff(gatheredContext.diff, excludedPaths),
        ...(includedFiles !== undefined
          ? {
              additions: includedFiles.reduce((sum, file) => sum + file.additions, 0),
              deletions: includedFiles.reduce((sum, file) => sum + file.deletions, 0),
              changedFiles: includedFiles.length,
            }
          : {}),
      };

      if (context.compareCommits.length === 0) {
        return;
      }

      // Business rule: a push that is really a PR merge or a release version bump
      // is already summarized by the PR/release pipeline — skip it here to avoid a
      // duplicate push summary. Detected race-free via the sibling jobs.
      const overlap = await findPushOverlap({
        db: input.db,
        repo: job.repo,
        afterSha: job.afterSha,
        prNumbers: context.prNumbers,
      });
      if (overlap.skip) {
        console.log(
          `[process_push] skipped ${job.repo}@${job.afterSha.slice(0, 7)} (${overlap.reason})`,
        );
        return;
      }

      const summary = await input.pushSummarizer.summarizePush({
        context,
        repo: job.repo,
        branch: job.branch,
      });

      const publish = await publishBestEffort("publishPush", () =>
        input.destination.publishPush({
          repo: job.repo,
          branch: job.branch,
          beforeSha: job.beforeSha,
          afterSha: job.afterSha,
          pusher: job.pusher,
          pushedAt: job.pushedAt,
          title: summary.title,
          summaryUserFacing: summary.summaryUserFacing,
          summaryTechnical: summary.summaryTechnical,
          category: summary.category,
          area: summary.area,
          commitCount: context.totalCommits,
          prNumbers: context.prNumbers,
          compareUrl: context.compareUrl,
        }),
      );

      const pushValues = {
        repo: job.repo,
        branch: job.branch,
        beforeSha: job.beforeSha,
        afterSha: job.afterSha,
        pusher: job.pusher,
        pushedAt: job.pushedAt,
        commitCount: context.totalCommits,
        additions: context.additions,
        deletions: context.deletions,
        changedFiles: context.changedFiles,
        prNumbers: context.prNumbers,
        title: summary.title,
        summaryUserFacing: summary.summaryUserFacing,
        summaryTechnical: summary.summaryTechnical,
        category: summary.category,
        area: summary.area,
        compareUrl: context.compareUrl,
        notionPageId: publish.pageId,
        promptVersion: input.promptVersion,
        updatedAt: new Date(),
      };
      const pushRows = await input.db
        .insert(pushesTable)
        .values(pushValues)
        .onConflictDoUpdate({
          target: [pushesTable.repo, pushesTable.afterSha],
          set: pushValues,
        })
        .returning({ id: pushesTable.id });

      const pushRow = pushRows[0];
      if (pushRow === undefined) {
        throw new Error("Push upsert did not return a source record id.");
      }

      if (input.canonicalProjection !== undefined) {
        await input.canonicalProjection.projector.project({
          workspaceId: input.canonicalProjection.workspaceId,
          sourceRecordId: pushRow.id,
          repo: job.repo,
          branch: job.branch,
          beforeSha: job.beforeSha,
          afterSha: job.afterSha,
          pusher: job.pusher,
          pushedAt: job.pushedAt,
          context,
          summary,
          promptVersion: input.promptVersion,
        });
      }

      await recordLlmUsage({
        db: input.db,
        repo: job.repo,
        jobType: "process_push",
        usage: summary.usage,
      });
    },
  };
};
