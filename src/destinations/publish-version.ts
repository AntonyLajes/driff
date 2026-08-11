import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { projectVersionsTable, releasesTable } from "@/db/schema.js";
import type {
  Destination,
  ReleaseNotesSummary,
} from "@/destinations/destination.js";

export interface PublishVersionInput {
  db: Database;
  workspaceId: string;
  repoFullName: string;
  repoDefaultBranch: string;
  versionId: string;
  destination: Destination;
}

export type PublishVersionResult =
  | { kind: "not_found" }
  | { kind: "not_released" }
  | { kind: "summary_not_ready" }
  | {
      kind: "published";
      pageId: string;
      pageUrl: string;
      summary: ReleaseNotesSummary;
    };

const notionPageUrl = (pageId: string): string =>
  `https://www.notion.so/${pageId.replaceAll("-", "")}`;

export const execute = async (
  input: PublishVersionInput,
): Promise<PublishVersionResult> => {
  const versionRows = await input.db
    .select({
      id: projectVersionsTable.id,
      displayVersion: projectVersionsTable.displayVersion,
      normalizedVersion: projectVersionsTable.normalizedVersion,
      buildVersion: projectVersionsTable.buildVersion,
      title: projectVersionsTable.title,
      changelog: projectVersionsTable.changelog,
      sections: projectVersionsTable.sections,
      status: projectVersionsTable.status,
      sourceUrl: projectVersionsTable.sourceUrl,
      sourceReleaseId: projectVersionsTable.sourceReleaseId,
      beforeSha: projectVersionsTable.beforeSha,
      headSha: projectVersionsTable.headSha,
    })
    .from(projectVersionsTable)
    .where(
      and(
        eq(projectVersionsTable.workspaceId, input.workspaceId),
        eq(projectVersionsTable.id, input.versionId),
      ),
    )
    .limit(1);
  const version = versionRows[0];
  if (version === undefined) return { kind: "not_found" };
  if (version.status !== "released") return { kind: "not_released" };
  if (version.title === null || version.changelog === null) {
    return { kind: "summary_not_ready" };
  }

  const releaseRows =
    version.sourceReleaseId === null
      ? []
      : await input.db
          .select({
            id: releasesTable.id,
            versionKey: releasesTable.versionKey,
            previousVersionKey: releasesTable.previousVersionKey,
            branch: releasesTable.branch,
            prNumbers: releasesTable.prNumbers,
          })
          .from(releasesTable)
          .where(eq(releasesTable.id, version.sourceReleaseId))
          .limit(1);
  const release = releaseRows[0];
  const compareUrl =
    version.sourceUrl ??
    (version.beforeSha !== null && version.headSha !== null
      ? `https://github.com/${input.repoFullName}/compare/${encodeURIComponent(version.beforeSha)}...${encodeURIComponent(version.headSha)}`
      : `https://github.com/${input.repoFullName}`);
  const summary: ReleaseNotesSummary = {
    title: version.title,
    repo: input.repoFullName,
    branch: release?.branch ?? input.repoDefaultBranch,
    newVersionKey: release?.versionKey ?? version.normalizedVersion,
    previousVersionKey: release?.previousVersionKey ?? null,
    shortVersion: version.displayVersion,
    buildVersion: version.buildVersion ?? "",
    compareUrl,
    prNumbers: release?.prNumbers ?? [],
    changelog: version.changelog,
    sections: version.sections ?? [],
  };

  const published = await input.destination.publishRelease(summary);
  if (published.pageId.trim().length === 0) {
    throw new Error("Notion release publishing returned an empty page id.");
  }
  if (release !== undefined) {
    await input.db
      .update(releasesTable)
      .set({ notionPageId: published.pageId, updatedAt: new Date() })
      .where(eq(releasesTable.id, release.id));
  }

  return {
    kind: "published",
    pageId: published.pageId,
    pageUrl: notionPageUrl(published.pageId),
    summary,
  };
};
