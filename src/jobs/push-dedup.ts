import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { jobsTable } from "@/db/schema.js";

/**
 * Decides whether a push summary should be skipped because the same change is
 * already covered by the PR or release pipeline (the "don't double-publish a PR
 * merge" business rule).
 *
 * Detection is race-free: it looks at the `jobs` table, whose rows are inserted
 * at enqueue time (before any job runs). The PR/release jobs for a given push
 * are enqueued by the same webhook delivery, so they are always visible here —
 * this covers "already processed" AND "currently being processed".
 *
 * - Release overlap: a `process_release` job exists for the same repo + afterSha
 *   (a version-bump push to the release branch).
 * - PR-merge overlap: every PR number referenced by the push (extracted from
 *   merge/squash commit messages) has a `process_pr` job for this repo. Requiring
 *   *all* of them fails safe — a push mixing PR merges with un-summarized direct
 *   commits is still published.
 */
export interface FindPushOverlapInput {
  db: Database;
  repo: string;
  afterSha: string;
  prNumbers: number[];
}

export interface PushOverlap {
  skip: boolean;
  reason: "release_push" | "pr_merge_push" | null;
}

const NO_OVERLAP: PushOverlap = { skip: false, reason: null };

const hasReleaseJobForAfterSha = async (
  db: Database,
  repo: string,
  afterSha: string,
): Promise<boolean> => {
  const rows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.type, "process_release"),
        sql`(${jobsTable.payload} ->> 'repo') = ${repo}`,
        sql`(${jobsTable.payload} ->> 'afterSha') = ${afterSha}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
};

const hasProcessPrJob = async (
  db: Database,
  repo: string,
  prNumber: number,
): Promise<boolean> => {
  const rows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.type, "process_pr"),
        sql`(${jobsTable.payload} ->> 'repo') = ${repo}`,
        sql`(${jobsTable.payload} ->> 'prNumber') = ${String(prNumber)}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
};

export const findPushOverlap = async (input: FindPushOverlapInput): Promise<PushOverlap> => {
  if (await hasReleaseJobForAfterSha(input.db, input.repo, input.afterSha)) {
    return { skip: true, reason: "release_push" };
  }

  if (input.prNumbers.length > 0) {
    const covered = await Promise.all(
      input.prNumbers.map((n) => hasProcessPrJob(input.db, input.repo, n)),
    );
    if (covered.every(Boolean)) {
      return { skip: true, reason: "pr_merge_push" };
    }
  }

  return NO_OVERLAP;
};
