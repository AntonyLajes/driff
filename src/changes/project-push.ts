import { execute as buildCanonicalId } from "@/changes/canonical-id.js";
import type { Database } from "@/db/client.js";
import {
  changeAreasTable,
  changeContributorsTable,
  changeEvidenceTable,
  changesTable,
  productAreasTable,
} from "@/db/schema.js";
import type { PushSummaryResult } from "@/llm/push-summarizer.js";
import { execute as projectLineageChange } from "@/lineages/project-change.js";
import type { PushContext } from "@/sources/github/gather-push-context.js";

export interface PushProjectionInput {
  workspaceId: string;
  sourceRecordId: string;
  repo: string;
  branch: string;
  beforeSha: string;
  afterSha: string;
  pusher: string | null;
  pushedAt: Date;
  context: PushContext;
  summary: PushSummaryResult;
  promptVersion: number | null;
}

export interface PushProjector {
  project: (input: PushProjectionInput) => Promise<void>;
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

const extractFilePaths = (summary: string): string[] =>
  summary
    .split("\n")
    .map((line) => line.match(/^[^:]+:\s+(.+)$/u)?.[1]?.trim() ?? "")
    .filter((path, index, all) =>
      path.length > 0 && !path.startsWith("…") && all.indexOf(path) === index,
    );

export const execute = ({
  db,
  lineageProjector = projectLineageChange,
}: ExecuteInput): PushProjector => ({
  project: async (input) => {
    const normalizedRepo = input.repo.trim().toLowerCase();
    const pushSourceKey = `github:${normalizedRepo}:push:${input.afterSha}`;
    const compareSourceKey = `github:${normalizedRepo}:compare:${input.beforeSha}...${input.afterSha}`;
    const changeId = buildCanonicalId(
      "change",
      input.workspaceId,
      pushSourceKey,
    );
    const now = new Date();
    const areaName = input.summary.area?.trim() ?? "";
    const areaSlug = slugify(areaName);
    const projectedArea =
      areaSlug.length === 0
        ? null
        : {
            id: buildCanonicalId(
              "product-area",
              input.workspaceId,
              areaSlug,
            ),
            slug: areaSlug,
          };
    const filePaths = extractFilePaths(input.context.fileChangeSummary);

    await db.transaction(async (tx) => {
      await tx
        .insert(changesTable)
        .values({
          id: changeId,
          workspaceId: input.workspaceId,
          title: input.summary.title,
          summaryExecutive: input.summary.summaryUserFacing,
          summaryTechnical: input.summary.summaryTechnical,
          category: input.summary.category,
          firstOccurredAt: input.pushedAt,
          lastOccurredAt: input.pushedAt,
          promptVersion: input.promptVersion,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: changesTable.id,
          set: {
            title: input.summary.title,
            summaryExecutive: input.summary.summaryUserFacing,
            summaryTechnical: input.summary.summaryTechnical,
            category: input.summary.category,
            firstOccurredAt: input.pushedAt,
            lastOccurredAt: input.pushedAt,
            promptVersion: input.promptVersion,
            updatedAt: now,
          },
        });

      await tx
        .insert(changeEvidenceTable)
        .values([
          {
            changeId,
            kind: "compare",
            sourceKey: compareSourceKey,
            externalId: input.afterSha,
            url: input.context.compareUrl,
            sha: input.afterSha,
            occurredAt: input.pushedAt,
            sourceRecordType: "pushes",
            sourceRecordId: input.sourceRecordId,
            metadata: {
              branch: input.branch,
              beforeSha: input.beforeSha,
              commitCount: input.context.totalCommits,
              additions: input.context.additions,
              deletions: input.context.deletions,
              changedFiles: input.context.changedFiles,
            },
          },
          ...input.context.compareCommits.map((commit) => ({
            changeId,
            kind: "commit",
            sourceKey: `github:${normalizedRepo}:commit:${commit.sha}`,
            externalId: commit.sha,
            url: `https://github.com/${input.repo}/commit/${commit.sha}`,
            sha: commit.sha,
            occurredAt: input.pushedAt,
            sourceRecordType: "pushes",
            sourceRecordId: input.sourceRecordId,
            metadata: {
              branch: input.branch,
              message: commit.message,
            },
          })),
          ...filePaths.map((path) => ({
            changeId,
            kind: "file",
            sourceKey: `${compareSourceKey}:file:${path}`,
            externalId: input.afterSha,
            url: input.context.compareUrl,
            sha: input.afterSha,
            path,
            occurredAt: input.pushedAt,
            sourceRecordType: "pushes",
            sourceRecordId: input.sourceRecordId,
            metadata: { branch: input.branch },
          })),
        ])
        .onConflictDoUpdate({
          target: [changeEvidenceTable.changeId, changeEvidenceTable.sourceKey],
          set: {
            occurredAt: input.pushedAt,
            sourceRecordType: "pushes",
            sourceRecordId: input.sourceRecordId,
          },
        });

      if (projectedArea !== null) {
        await tx
          .insert(productAreasTable)
          .values({
            id: projectedArea.id,
            workspaceId: input.workspaceId,
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
          .values({ changeId, areaId: projectedArea.id, source: "ai" })
          .onConflictDoUpdate({
            target: [changeAreasTable.changeId, changeAreasTable.areaId],
            set: { source: "ai" },
          });
      }

      const pusher = input.pusher?.trim() ?? "";
      if (pusher.length > 0) {
        await tx
          .insert(changeContributorsTable)
          .values({
            changeId,
            externalIdentity: `github:${pusher.toLowerCase()}`,
            displayName: pusher,
            role: "pusher",
            sourceUrl: `https://github.com/${encodeURIComponent(pusher)}`,
          })
          .onConflictDoUpdate({
            target: [
              changeContributorsTable.changeId,
              changeContributorsTable.externalIdentity,
              changeContributorsTable.role,
            ],
            set: {
              displayName: pusher,
              sourceUrl: `https://github.com/${encodeURIComponent(pusher)}`,
            },
          });
      }
    });

    if (projectedArea !== null) {
      await lineageProjector({
        db,
        workspaceId: input.workspaceId,
        changeId,
        title: input.summary.title,
        category: input.summary.category,
        areaId: projectedArea.id,
        areaSlug: projectedArea.slug,
        filePaths,
      });
    }
  },
});
