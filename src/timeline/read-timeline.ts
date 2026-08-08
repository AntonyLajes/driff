import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
} from "drizzle-orm";

import type { Database } from "@/db/client.js";
import {
  changeAreasTable,
  changeContributorsTable,
  changeEvidenceTable,
  changesTable,
  productAreasTable,
  projectVersionsTable,
} from "@/db/schema.js";

const MAX_PAGE_SIZE = 20;
const DEFAULT_PAGE_SIZE = 10;
const IN_DEVELOPMENT_LIMIT = 50;

export interface TimelineCursor {
  releasedAt: Date;
  id: string;
}

export interface ExecuteInput {
  db: Database;
  workspaceId: string;
  limit?: number;
  cursor?: TimelineCursor | null;
}

const normalizeLimit = (value: number | undefined): number => {
  if (value === undefined || !Number.isInteger(value)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(value, 1), MAX_PAGE_SIZE);
};

export const execute = async (input: ExecuteInput) => {
  const limit = normalizeLimit(input.limit);
  const cursor = input.cursor ?? null;
  const versionConditions: SQL[] = [
    eq(projectVersionsTable.workspaceId, input.workspaceId),
    eq(projectVersionsTable.status, "released"),
    isNotNull(projectVersionsTable.releasedAt),
  ];
  if (cursor !== null) {
    versionConditions.push(
      or(
        lt(projectVersionsTable.releasedAt, cursor.releasedAt),
        and(
          eq(projectVersionsTable.releasedAt, cursor.releasedAt),
          lt(projectVersionsTable.id, cursor.id),
        ),
      )!,
    );
  }

  const versionRowsWithExtra = await input.db
    .select({
      id: projectVersionsTable.id,
      displayVersion: projectVersionsTable.displayVersion,
      normalizedVersion: projectVersionsTable.normalizedVersion,
      buildVersion: projectVersionsTable.buildVersion,
      title: projectVersionsTable.title,
      changelog: projectVersionsTable.changelog,
      sections: projectVersionsTable.sections,
      sourceUrl: projectVersionsTable.sourceUrl,
      previousVersionId: projectVersionsTable.previousVersionId,
      beforeSha: projectVersionsTable.beforeSha,
      headSha: projectVersionsTable.headSha,
      releasedAt: projectVersionsTable.releasedAt,
    })
    .from(projectVersionsTable)
    .where(and(...versionConditions))
    .orderBy(desc(projectVersionsTable.releasedAt), desc(projectVersionsTable.id))
    .limit(limit + 1);

  const hasNextPage = versionRowsWithExtra.length > limit;
  const versionRows = versionRowsWithExtra.slice(0, limit);
  const versionIds = versionRows.map((row) => row.id);

  const versionedChanges =
    versionIds.length === 0
      ? []
      : await input.db
          .select({
            id: changesTable.id,
            versionId: changesTable.versionId,
            title: changesTable.title,
            summaryExecutive: changesTable.summaryExecutive,
            summaryTechnical: changesTable.summaryTechnical,
            category: changesTable.category,
            confidence: changesTable.confidence,
            firstOccurredAt: changesTable.firstOccurredAt,
            lastOccurredAt: changesTable.lastOccurredAt,
          })
          .from(changesTable)
          .where(
            and(
              eq(changesTable.workspaceId, input.workspaceId),
              inArray(changesTable.versionId, versionIds),
            ),
          )
          .orderBy(desc(changesTable.lastOccurredAt), desc(changesTable.id));

  const unversionedRowsWithExtra =
    cursor !== null
      ? []
      : await input.db
          .select({
            id: changesTable.id,
            versionId: changesTable.versionId,
            title: changesTable.title,
            summaryExecutive: changesTable.summaryExecutive,
            summaryTechnical: changesTable.summaryTechnical,
            category: changesTable.category,
            confidence: changesTable.confidence,
            firstOccurredAt: changesTable.firstOccurredAt,
            lastOccurredAt: changesTable.lastOccurredAt,
          })
          .from(changesTable)
          .where(
            and(
              eq(changesTable.workspaceId, input.workspaceId),
              isNull(changesTable.versionId),
            ),
          )
          .orderBy(desc(changesTable.lastOccurredAt), desc(changesTable.id))
          .limit(IN_DEVELOPMENT_LIMIT + 1);
  const hasMoreInDevelopment =
    unversionedRowsWithExtra.length > IN_DEVELOPMENT_LIMIT;
  const unversionedChanges = unversionedRowsWithExtra.slice(
    0,
    IN_DEVELOPMENT_LIMIT,
  );
  const allChanges = [...versionedChanges, ...unversionedChanges];
  const changeIds = allChanges.map((row) => row.id);

  const contributorRows =
    changeIds.length === 0
      ? []
      : await input.db
          .select({
            changeId: changeContributorsTable.changeId,
            externalIdentity: changeContributorsTable.externalIdentity,
            displayName: changeContributorsTable.displayName,
            role: changeContributorsTable.role,
            sourceUrl: changeContributorsTable.sourceUrl,
          })
          .from(changeContributorsTable)
          .where(inArray(changeContributorsTable.changeId, changeIds));
  const areaRows =
    changeIds.length === 0
      ? []
      : await input.db
          .select({
            changeId: changeAreasTable.changeId,
            id: productAreasTable.id,
            name: productAreasTable.name,
            slug: productAreasTable.slug,
            confidence: changeAreasTable.confidence,
            source: changeAreasTable.source,
          })
          .from(changeAreasTable)
          .innerJoin(
            productAreasTable,
            eq(changeAreasTable.areaId, productAreasTable.id),
          )
          .where(inArray(changeAreasTable.changeId, changeIds));
  const evidenceRows =
    changeIds.length === 0
      ? []
      : await input.db
          .select({
            id: changeEvidenceTable.id,
            changeId: changeEvidenceTable.changeId,
            kind: changeEvidenceTable.kind,
            sourceKey: changeEvidenceTable.sourceKey,
            externalId: changeEvidenceTable.externalId,
            url: changeEvidenceTable.url,
            sha: changeEvidenceTable.sha,
            path: changeEvidenceTable.path,
            occurredAt: changeEvidenceTable.occurredAt,
            metadata: changeEvidenceTable.metadata,
          })
          .from(changeEvidenceTable)
          .where(inArray(changeEvidenceTable.changeId, changeIds))
          .orderBy(desc(changeEvidenceTable.occurredAt), desc(changeEvidenceTable.id));

  const contributorsByChange = new Map<
    string,
    Array<(typeof contributorRows)[number]>
  >();
  for (const row of contributorRows) {
    const rows = contributorsByChange.get(row.changeId) ?? [];
    rows.push(row);
    contributorsByChange.set(row.changeId, rows);
  }
  const areasByChange = new Map<string, Array<(typeof areaRows)[number]>>();
  for (const row of areaRows) {
    const rows = areasByChange.get(row.changeId) ?? [];
    rows.push(row);
    areasByChange.set(row.changeId, rows);
  }
  const evidenceByChange = new Map<
    string,
    Array<(typeof evidenceRows)[number]>
  >();
  for (const row of evidenceRows) {
    const rows = evidenceByChange.get(row.changeId) ?? [];
    rows.push(row);
    evidenceByChange.set(row.changeId, rows);
  }

  const serializeChange = (row: (typeof allChanges)[number]) => ({
    id: row.id,
    title: row.title,
    summaryExecutive: row.summaryExecutive,
    summaryTechnical: row.summaryTechnical,
    category: row.category,
    confidence: row.confidence,
    firstOccurredAt: row.firstOccurredAt.toISOString(),
    lastOccurredAt: row.lastOccurredAt.toISOString(),
    areas: (areasByChange.get(row.id) ?? []).map((area) => ({
      id: area.id,
      name: area.name,
      slug: area.slug,
      confidence: area.confidence,
      source: area.source,
    })),
    contributors: (contributorsByChange.get(row.id) ?? []).map(
      (contributor) => ({
        externalIdentity: contributor.externalIdentity,
        displayName: contributor.displayName,
        role: contributor.role,
        sourceUrl: contributor.sourceUrl,
      }),
    ),
    evidence: (evidenceByChange.get(row.id) ?? []).map((evidence) => ({
      id: evidence.id,
      kind: evidence.kind,
      sourceKey: evidence.sourceKey,
      externalId: evidence.externalId,
      url: evidence.url,
      sha: evidence.sha,
      path: evidence.path,
      occurredAt: evidence.occurredAt.toISOString(),
      metadata: evidence.metadata,
    })),
  });

  const changesByVersion = new Map<
    string,
    ReturnType<typeof serializeChange>[]
  >();
  for (const row of versionedChanges) {
    if (row.versionId === null) continue;
    const rows = changesByVersion.get(row.versionId) ?? [];
    rows.push(serializeChange(row));
    changesByVersion.set(row.versionId, rows);
  }

  const lastVersion = versionRows.at(-1);
  const nextCursor =
    hasNextPage && lastVersion?.releasedAt != null
      ? { releasedAt: lastVersion.releasedAt, id: lastVersion.id }
      : null;

  return {
    versions: versionRows.map((version) => ({
      id: version.id,
      displayVersion: version.displayVersion,
      normalizedVersion: version.normalizedVersion,
      buildVersion: version.buildVersion,
      title: version.title,
      changelog: version.changelog,
      sections: version.sections,
      sourceUrl: version.sourceUrl,
      previousVersionId: version.previousVersionId,
      beforeSha: version.beforeSha,
      headSha: version.headSha,
      releasedAt: version.releasedAt?.toISOString() ?? null,
      changes: changesByVersion.get(version.id) ?? [],
    })),
    inDevelopment:
      cursor === null
        ? {
            changes: unversionedChanges.map(serializeChange),
            hasMore: hasMoreInDevelopment,
          }
        : null,
    pageInfo: {
      hasNextPage,
      nextCursor,
    },
  };
};
