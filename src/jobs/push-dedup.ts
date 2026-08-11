import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { jobsTable, pullRequestsTable, releasesTable } from "@/db/schema.js";

/**
 * Decides whether a push summary should be skipped because the same change is
 * already covered by the PR or release pipeline (the "don't double-publish a PR
 * merge" business rule).
 *
 * Detection covers both ingestion modes: webhook jobs are visible in `jobs`
 * before processing, while history imports invoke canonical processors directly
 * and leave their durable PR/release source rows before commit processing begins.
 *
 * - Release overlap: a matching `process_release` job or stored release exists.
 * - PR-merge overlap: every referenced PR has a matching job or stored PR row.
 * Requiring *all* referenced PRs fails safe for mixed direct/merge pushes.
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

const hasStoredReleaseForAfterSha = async (
  db: Database,
  repo: string,
  afterSha: string,
): Promise<boolean> => {
  const rows = await db
    .select({ id: releasesTable.id })
    .from(releasesTable)
    .where(
      and(eq(releasesTable.repo, repo), eq(releasesTable.headSha, afterSha)),
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

const hasStoredPullRequest = async (
  db: Database,
  repo: string,
  prNumber: number,
): Promise<boolean> => {
  const rows = await db
    .select({ id: pullRequestsTable.id })
    .from(pullRequestsTable)
    .where(
      and(
        eq(pullRequestsTable.repo, repo),
        eq(pullRequestsTable.prNumber, prNumber),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

export const findPushOverlap = async (
  input: FindPushOverlapInput,
): Promise<PushOverlap> => {
  if (
    (await hasReleaseJobForAfterSha(input.db, input.repo, input.afterSha)) ||
    (await hasStoredReleaseForAfterSha(input.db, input.repo, input.afterSha))
  ) {
    return { skip: true, reason: "release_push" };
  }

  if (input.prNumbers.length > 0) {
    const covered = await Promise.all(
      input.prNumbers.map(
        async (prNumber) =>
          (await hasProcessPrJob(input.db, input.repo, prNumber)) ||
          (await hasStoredPullRequest(input.db, input.repo, prNumber)),
      ),
    );
    if (covered.every(Boolean)) {
      return { skip: true, reason: "pr_merge_push" };
    }
  }

  return NO_OVERLAP;
};
