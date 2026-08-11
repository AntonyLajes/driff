import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  execute as inspectWorkspaceParity,
  type WorkspaceParityReport,
} from "@/changes/inspect-workspace-parity.js";
import type { PullRequestProjector } from "@/changes/project-pull-request.js";
import type { PushProjector } from "@/changes/project-push.js";
import type { ReleaseProjector } from "@/changes/project-release.js";
import type { Database } from "@/db/client.js";
import {
  pullRequestsTable,
  pushesTable,
  releasesTable,
} from "@/db/schema.js";
import type { PushContext } from "@/sources/github/gather-push-context.js";
import type { Source } from "@/sources/source.js";

const categorySchema = z.enum([
  "feature",
  "bugfix",
  "refactor",
  "chore",
  "other",
]);
const releaseSectionsSchema = z.object({
  title: z.string().trim().min(1).optional(),
  sections: z
    .array(
      z.object({
        label: z.string().trim().min(1),
        items: z.array(z.string().trim().min(1)),
      }),
    )
    .optional(),
});

type SourceKind = "pullRequests" | "pushes" | "releases";

export interface BackfillSourceResult {
  candidates: number;
  ready: number;
  projected: number;
  skipped: Array<{ sourceRecordId: string; reason: string }>;
}

export interface BackfillWorkspaceResult {
  mode: "dry_run" | "apply";
  before: WorkspaceParityReport;
  after: WorkspaceParityReport;
  sources: Record<SourceKind, BackfillSourceResult>;
}

export interface LoadPushContextInput {
  repo: string;
  beforeSha: string;
  afterSha: string;
}

export interface ExecuteInput {
  db: Database;
  workspaceId: string;
  repo: string;
  apply?: boolean;
  source: Pick<Source, "fetchPullRequest">;
  loadPushContext: (input: LoadPushContextInput) => Promise<PushContext>;
  pullRequestProjector: PullRequestProjector;
  pushProjector: PushProjector;
  releaseProjector: ReleaseProjector;
  inspectParity?: typeof inspectWorkspaceParity;
}

const createSourceResult = (candidates: number): BackfillSourceResult => ({
  candidates,
  ready: 0,
  projected: 0,
  skipped: [],
});

const requiredText = (value: string | null): string | null => {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
};

export const execute = async (
  input: ExecuteInput,
): Promise<BackfillWorkspaceResult> => {
  const inspect = input.inspectParity ?? inspectWorkspaceParity;
  const before = await inspect({
    db: input.db,
    workspaceId: input.workspaceId,
    repo: input.repo,
  });
  const missingPrIds = before.sources.pullRequests.missingSourceRecordIds;
  const missingPushIds = before.sources.pushes.missingSourceRecordIds;
  const missingReleaseIds = before.sources.releases.missingSourceRecordIds;

  const pullRequestRows =
    missingPrIds.length === 0
      ? []
      : await input.db
          .select()
          .from(pullRequestsTable)
          .where(
            and(
              eq(pullRequestsTable.repo, before.repo),
              inArray(pullRequestsTable.id, missingPrIds),
            ),
          )
          .orderBy(asc(pullRequestsTable.mergedAt), asc(pullRequestsTable.id));
  const pushRows =
    missingPushIds.length === 0
      ? []
      : await input.db
          .select()
          .from(pushesTable)
          .where(
            and(
              eq(pushesTable.repo, before.repo),
              inArray(pushesTable.id, missingPushIds),
            ),
          )
          .orderBy(asc(pushesTable.pushedAt), asc(pushesTable.id));
  const releaseRows =
    missingReleaseIds.length === 0
      ? []
      : await input.db
          .select()
          .from(releasesTable)
          .where(
            and(
              eq(releasesTable.repo, before.repo),
              inArray(releasesTable.id, missingReleaseIds),
            ),
          )
          .orderBy(asc(releasesTable.createdAt), asc(releasesTable.id));

  const sources = {
    pullRequests: createSourceResult(missingPrIds.length),
    pushes: createSourceResult(missingPushIds.length),
    releases: createSourceResult(missingReleaseIds.length),
  };
  const apply = input.apply === true;

  for (const row of pullRequestRows) {
    const summaryUserFacing = requiredText(row.summaryUserFacing);
    const summaryTechnical = requiredText(row.summaryTechnical);
    const category = categorySchema.safeParse(row.category);
    if (
      summaryUserFacing === null ||
      summaryTechnical === null ||
      !category.success
    ) {
      sources.pullRequests.skipped.push({
        sourceRecordId: row.id,
        reason: "legacy_summary_incomplete",
      });
      continue;
    }
    sources.pullRequests.ready += 1;
    if (!apply) continue;

    const pullRequest = await input.source.fetchPullRequest(
      before.repo,
      row.prNumber,
    );
    await input.pullRequestProjector.project({
      workspaceId: input.workspaceId,
      sourceRecordId: row.id,
      pullRequest,
      summary: {
        title: row.title,
        summaryUserFacing,
        summaryTechnical,
        category: category.data,
        area: requiredText(row.area),
      },
      promptVersion: row.promptVersion,
    });
    sources.pullRequests.projected += 1;
  }

  for (const row of pushRows) {
    const title = requiredText(row.title);
    const summaryUserFacing = requiredText(row.summaryUserFacing);
    const summaryTechnical = requiredText(row.summaryTechnical);
    const category = categorySchema.safeParse(row.category);
    if (
      title === null ||
      summaryUserFacing === null ||
      summaryTechnical === null ||
      !category.success
    ) {
      sources.pushes.skipped.push({
        sourceRecordId: row.id,
        reason: "legacy_summary_incomplete",
      });
      continue;
    }
    sources.pushes.ready += 1;
    if (!apply) continue;

    const context = await input.loadPushContext({
      repo: before.repo,
      beforeSha: row.beforeSha,
      afterSha: row.afterSha,
    });
    await input.pushProjector.project({
      workspaceId: input.workspaceId,
      sourceRecordId: row.id,
      repo: before.repo,
      branch: row.branch,
      beforeSha: row.beforeSha,
      afterSha: row.afterSha,
      pusher: row.pusher,
      pushedAt: row.pushedAt,
      context,
      summary: {
        title,
        summaryUserFacing,
        summaryTechnical,
        category: category.data,
        area: requiredText(row.area),
      },
      promptVersion: row.promptVersion,
    });
    sources.pushes.projected += 1;
  }

  for (const row of releaseRows) {
    const parsedSections = releaseSectionsSchema.safeParse(row.sections ?? {});
    const build = row.buildVersion.trim();
    const fallbackTitle =
      build.length > 0
        ? `Version ${row.shortVersion} (${build})`
        : `Version ${row.shortVersion}`;
    const releaseTitle = parsedSections.success
      ? (parsedSections.data.title ?? fallbackTitle)
      : fallbackTitle;
    const sections = parsedSections.success
      ? (parsedSections.data.sections ?? [])
      : [];
    sources.releases.ready += 1;
    if (!apply) continue;

    const context = await input.loadPushContext({
      repo: before.repo,
      beforeSha: row.beforeSha,
      afterSha: row.headSha,
    });
    await input.releaseProjector.project({
      workspaceId: input.workspaceId,
      sourceReleaseId: row.id,
      repo: before.repo,
      versionKey: row.versionKey,
      previousVersionKey: row.previousVersionKey,
      shortVersion: row.shortVersion,
      buildVersion: row.buildVersion,
      title: releaseTitle,
      changelog: row.changelog,
      sections,
      promptVersion: row.promptVersion,
      beforeSha: row.beforeSha,
      headSha: row.headSha,
      compareUrl: context.compareUrl,
      prNumbers: row.prNumbers,
      commitShas: context.compareCommits.map((commit) => commit.sha),
      releasedAt: row.createdAt,
    });
    sources.releases.projected += 1;
  }

  const after = apply
    ? await inspect({
        db: input.db,
        workspaceId: input.workspaceId,
        repo: input.repo,
      })
    : before;

  return {
    mode: apply ? "apply" : "dry_run",
    before,
    after,
    sources,
  };
};
