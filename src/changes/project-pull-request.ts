import { execute as buildCanonicalId } from "@/changes/canonical-id.js";
import type { Database } from "@/db/client.js";
import {
  changeAreasTable,
  changeContributorsTable,
  changeEvidenceTable,
  changesTable,
  productAreasTable,
} from "@/db/schema.js";
import type { PRSummary } from "@/llm/summarizer.js";
import { execute as projectLineageChange } from "@/lineages/project-change.js";
import type { PullRequestEvent } from "@/sources/source.js";

export interface PullRequestProjectionInput {
  workspaceId: string;
  sourceRecordId: string;
  pullRequest: PullRequestEvent;
  summary: PRSummary;
  promptVersion: number | null;
}

export interface PullRequestProjector {
  project: (input: PullRequestProjectionInput) => Promise<void>;
}

export interface ExecuteInput {
  db: Database;
  lineageProjector?: typeof projectLineageChange;
}

const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

export const execute = ({
  db,
  lineageProjector = projectLineageChange,
}: ExecuteInput): PullRequestProjector => ({
  project: async ({
    workspaceId,
    sourceRecordId,
    pullRequest,
    summary,
    promptVersion,
  }) => {
    const normalizedRepo = pullRequest.repo.trim().toLowerCase();
    const pullRequestUrl = `https://github.com/${pullRequest.repo}/pull/${pullRequest.prNumber}`;
    const pullRequestSourceKey = `github:${normalizedRepo}:pull_request:${pullRequest.prNumber}`;
    const changeId = buildCanonicalId(
      "change",
      workspaceId,
      pullRequestSourceKey,
    );
    const now = new Date();
    const areaName = summary.area?.trim() ?? "";
    const areaSlug = slugify(areaName);
    const projectedArea =
      areaSlug.length === 0
        ? null
        : {
            id: buildCanonicalId("product-area", workspaceId, areaSlug),
            slug: areaSlug,
          };

    await db.transaction(async (tx) => {
      await tx
        .insert(changesTable)
        .values({
          id: changeId,
          workspaceId,
          title: summary.title,
          summaryExecutive: summary.summaryUserFacing,
          summaryTechnical: summary.summaryTechnical,
          category: summary.category,
          firstOccurredAt: pullRequest.mergedAt,
          lastOccurredAt: pullRequest.mergedAt,
          promptVersion,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: changesTable.id,
          set: {
            title: summary.title,
            summaryExecutive: summary.summaryUserFacing,
            summaryTechnical: summary.summaryTechnical,
            category: summary.category,
            firstOccurredAt: pullRequest.mergedAt,
            lastOccurredAt: pullRequest.mergedAt,
            promptVersion,
            updatedAt: now,
          },
        });

      await tx
        .insert(changeEvidenceTable)
        .values([
          {
            changeId,
            kind: "pull_request",
            sourceKey: pullRequestSourceKey,
            externalId: String(pullRequest.prNumber),
            url: pullRequestUrl,
            sha: pullRequest.headSha,
            occurredAt: pullRequest.mergedAt,
            sourceRecordType: "pull_requests",
            sourceRecordId,
            metadata: {
              title: pullRequest.title,
              baseBranch: pullRequest.baseBranch,
            },
          },
          ...pullRequest.files.map((file) => ({
            changeId,
            kind: "file",
            sourceKey: `${pullRequestSourceKey}:file:${file.path}`,
            url: pullRequestUrl,
            sha: pullRequest.headSha,
            path: file.path,
            occurredAt: pullRequest.mergedAt,
            sourceRecordType: "pull_requests",
            sourceRecordId,
            metadata: {
              additions: file.additions,
              deletions: file.deletions,
            },
          })),
        ])
        .onConflictDoUpdate({
          target: [changeEvidenceTable.changeId, changeEvidenceTable.sourceKey],
          set: {
            url: pullRequestUrl,
            sha: pullRequest.headSha,
            occurredAt: pullRequest.mergedAt,
            sourceRecordType: "pull_requests",
            sourceRecordId,
          },
        });

      if (projectedArea !== null) {
        await tx
          .insert(productAreasTable)
          .values({
            id: projectedArea.id,
            workspaceId,
            name: areaName,
            slug: projectedArea.slug,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [productAreasTable.workspaceId, productAreasTable.slug],
            set: { name: areaName, updatedAt: now },
          });

        await tx
          .insert(changeAreasTable)
          .values({
            changeId,
            areaId: projectedArea.id,
            source: "ai",
          })
          .onConflictDoUpdate({
            target: [changeAreasTable.changeId, changeAreasTable.areaId],
            set: { source: "ai" },
          });
      }

      const externalIdentity = `github:${pullRequest.author.trim().toLowerCase()}`;
      await tx
        .insert(changeContributorsTable)
        .values({
          changeId,
          externalIdentity,
          displayName: pullRequest.author,
          role: "pr_author",
          sourceUrl: `https://github.com/${encodeURIComponent(pullRequest.author)}`,
        })
        .onConflictDoUpdate({
          target: [
            changeContributorsTable.changeId,
            changeContributorsTable.externalIdentity,
            changeContributorsTable.role,
          ],
          set: {
            displayName: pullRequest.author,
            sourceUrl: `https://github.com/${encodeURIComponent(pullRequest.author)}`,
          },
        });
    });

    if (projectedArea !== null) {
      await lineageProjector({
        db,
        workspaceId,
        changeId,
        title: summary.title,
        category: summary.category,
        areaId: projectedArea.id,
        areaSlug: projectedArea.slug,
        filePaths: pullRequest.files.map((file) => file.path),
      });
    }
  },
});
