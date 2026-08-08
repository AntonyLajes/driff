import { createHash } from "node:crypto";

import type { Database } from "@/db/client.js";
import {
  changeAreasTable,
  changeContributorsTable,
  changeEvidenceTable,
  changesTable,
  productAreasTable,
} from "@/db/schema.js";
import type { PRSummary } from "@/llm/summarizer.js";
import type { PullRequestEvent } from "@/sources/source.js";

export interface PullRequestProjectionInput {
  workspaceId: string;
  sourceRecordId: string;
  pullRequest: PullRequestEvent;
  summary: PRSummary;
  promptVersion: number;
}

export interface PullRequestProjector {
  project: (input: PullRequestProjectionInput) => Promise<void>;
}

export interface ExecuteInput {
  db: Database;
}

const stableUuid = (...parts: string[]): string => {
  const digest = createHash("sha256").update(["driff:v1", ...parts].join("\0")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

export const execute = ({ db }: ExecuteInput): PullRequestProjector => ({
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
    const changeId = stableUuid("change", workspaceId, pullRequestSourceKey);
    const now = new Date();

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

      const areaName = summary.area?.trim() ?? "";
      const areaSlug = slugify(areaName);
      if (areaSlug.length > 0) {
        const areaId = stableUuid("product-area", workspaceId, areaSlug);

        await tx
          .insert(productAreasTable)
          .values({
            id: areaId,
            workspaceId,
            name: areaName,
            slug: areaSlug,
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
            areaId,
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
  },
});
