import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { pushesTable } from "@/db/schema.js";
import type { Destination } from "@/destinations/destination.js";
import type { PushSummarizer } from "@/llm/push-summarizer.js";
import { recordLlmUsage } from "@/llm/usage.js";
import { findPushOverlap } from "@/jobs/push-dedup.js";
import { execute as gatherPushContext } from "@/sources/github/gather-push-context.js";

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
  promptVersion: number;
}

const parsePayload = (payload: Record<string, unknown>): ProcessPushJobPayload => {
  const { repo, beforeSha, afterSha, branch, pusher, pushedAt } = payload;
  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error("Invalid process_push payload: repo must be a non-empty string.");
  }
  if (typeof beforeSha !== "string" || beforeSha.length === 0) {
    throw new Error("Invalid process_push payload: beforeSha must be a non-empty string.");
  }
  if (typeof afterSha !== "string" || afterSha.length === 0) {
    throw new Error("Invalid process_push payload: afterSha must be a non-empty string.");
  }
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error("Invalid process_push payload: branch must be a non-empty string.");
  }

  const pusherValue =
    typeof pusher === "string" && pusher.trim().length > 0 ? pusher.trim() : null;
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

      const existing = await input.db
        .select({ id: pushesTable.id })
        .from(pushesTable)
        .where(and(eq(pushesTable.repo, job.repo), eq(pushesTable.afterSha, job.afterSha)))
        .limit(1);
      if (existing.length > 0) {
        return;
      }

      const context = await gatherPushContext({
        appId: input.appId,
        privateKey: input.privateKey,
        repo: job.repo,
        beforeSha: job.beforeSha,
        afterSha: job.afterSha,
      });

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

      const publish = await input.destination.publishPush({
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
      });

      await input.db
        .insert(pushesTable)
        .values({
          repo: job.repo,
          branch: job.branch,
          beforeSha: job.beforeSha,
          afterSha: job.afterSha,
          pusher: job.pusher,
          pushedAt: job.pushedAt,
          commitCount: context.totalCommits,
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
        })
        .onConflictDoNothing({
          target: [pushesTable.repo, pushesTable.afterSha],
        });

      await recordLlmUsage({
        db: input.db,
        repo: job.repo,
        jobType: "process_push",
        usage: summary.usage,
      });
    },
  };
};
