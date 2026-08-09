import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import {
  changeAreasTable,
  changeContributorsTable,
  changeEvidenceTable,
  changeLineageEntriesTable,
  changeLineagesTable,
  changesTable,
  productAreasTable,
  projectVersionsTable,
} from "@/db/schema.js";

const MAX_LINEAGES = 50;

export interface ExecuteInput {
  db: Database;
  workspaceId: string;
  lineageId?: string;
}

export const execute = async (input: ExecuteInput) => {
  const lineageRows = await input.db
    .select({
      id: changeLineagesTable.id,
      key: changeLineagesTable.key,
      title: changeLineagesTable.title,
      description: changeLineagesTable.description,
      status: changeLineagesTable.status,
      source: changeLineagesTable.source,
      confidence: changeLineagesTable.confidence,
      mergedIntoLineageId: changeLineagesTable.mergedIntoLineageId,
      createdAt: changeLineagesTable.createdAt,
      updatedAt: changeLineagesTable.updatedAt,
    })
    .from(changeLineagesTable)
    .where(
      input.lineageId === undefined
        ? eq(changeLineagesTable.workspaceId, input.workspaceId)
        : and(
            eq(changeLineagesTable.workspaceId, input.workspaceId),
            eq(changeLineagesTable.id, input.lineageId),
          ),
    )
    .orderBy(desc(changeLineagesTable.updatedAt), desc(changeLineagesTable.id))
    .limit(input.lineageId === undefined ? MAX_LINEAGES : 1);
  const workspaceLineages = lineageRows;
  const lineageIds = workspaceLineages.map((lineage) => lineage.id);
  if (lineageIds.length === 0) return { lineages: [] };

  const entryRows = await input.db
    .select({
      lineageId: changeLineageEntriesTable.lineageId,
      relationType: changeLineageEntriesTable.relationType,
      occurredAt: changeLineageEntriesTable.occurredAt,
      assignmentSource: changeLineageEntriesTable.source,
      assignmentConfidence: changeLineageEntriesTable.confidence,
      correctedAt: changeLineageEntriesTable.correctedAt,
      changeId: changesTable.id,
      title: changesTable.title,
      summaryExecutive: changesTable.summaryExecutive,
      summaryTechnical: changesTable.summaryTechnical,
      category: changesTable.category,
      confidence: changesTable.confidence,
      firstOccurredAt: changesTable.firstOccurredAt,
      lastOccurredAt: changesTable.lastOccurredAt,
      versionId: projectVersionsTable.id,
      displayVersion: projectVersionsTable.displayVersion,
      buildVersion: projectVersionsTable.buildVersion,
      releasedAt: projectVersionsTable.releasedAt,
    })
    .from(changeLineageEntriesTable)
    .innerJoin(
      changesTable,
      eq(changeLineageEntriesTable.changeId, changesTable.id),
    )
    .leftJoin(
      projectVersionsTable,
      eq(changesTable.versionId, projectVersionsTable.id),
    )
    .where(inArray(changeLineageEntriesTable.lineageId, lineageIds))
    .orderBy(
      asc(changeLineageEntriesTable.occurredAt),
      asc(changeLineageEntriesTable.changeId),
    );
  const changeIds = Array.from(new Set(entryRows.map((entry) => entry.changeId)));

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
            externalId: changeEvidenceTable.externalId,
            url: changeEvidenceTable.url,
            sha: changeEvidenceTable.sha,
            path: changeEvidenceTable.path,
            occurredAt: changeEvidenceTable.occurredAt,
          })
          .from(changeEvidenceTable)
          .where(inArray(changeEvidenceTable.changeId, changeIds))
          .orderBy(asc(changeEvidenceTable.occurredAt));

  const contributorsByChange = new Map<string, typeof contributorRows>();
  for (const row of contributorRows) {
    const rows = contributorsByChange.get(row.changeId) ?? [];
    rows.push(row);
    contributorsByChange.set(row.changeId, rows);
  }
  const areasByChange = new Map<string, typeof areaRows>();
  for (const row of areaRows) {
    const rows = areasByChange.get(row.changeId) ?? [];
    rows.push(row);
    areasByChange.set(row.changeId, rows);
  }
  const evidenceByChange = new Map<string, typeof evidenceRows>();
  for (const row of evidenceRows) {
    const rows = evidenceByChange.get(row.changeId) ?? [];
    rows.push(row);
    evidenceByChange.set(row.changeId, rows);
  }
  const entriesByLineage = new Map<string, typeof entryRows>();
  for (const row of entryRows) {
    const rows = entriesByLineage.get(row.lineageId) ?? [];
    rows.push(row);
    entriesByLineage.set(row.lineageId, rows);
  }

  return {
    lineages: workspaceLineages.map((lineage) => ({
      id: lineage.id,
      key: lineage.key,
      title: lineage.title,
      description: lineage.description,
      status: lineage.status,
      source: lineage.source,
      confidence: lineage.confidence,
      mergedIntoLineageId: lineage.mergedIntoLineageId,
      createdAt: lineage.createdAt.toISOString(),
      updatedAt: lineage.updatedAt.toISOString(),
      entries: (entriesByLineage.get(lineage.id) ?? []).map((entry) => ({
        relationType: entry.relationType,
        occurredAt: entry.occurredAt.toISOString(),
        assignmentSource: entry.assignmentSource,
        assignmentConfidence: entry.assignmentConfidence,
        correctedAt: entry.correctedAt?.toISOString() ?? null,
        change: {
          id: entry.changeId,
          title: entry.title,
          summaryExecutive: entry.summaryExecutive,
          summaryTechnical: entry.summaryTechnical,
          category: entry.category,
          confidence: entry.confidence,
          firstOccurredAt: entry.firstOccurredAt.toISOString(),
          lastOccurredAt: entry.lastOccurredAt.toISOString(),
          version:
            entry.versionId === null
              ? null
              : {
                  id: entry.versionId,
                  displayVersion: entry.displayVersion!,
                  buildVersion: entry.buildVersion,
                  releasedAt: entry.releasedAt?.toISOString() ?? null,
                },
          areas: (areasByChange.get(entry.changeId) ?? []).map((area) => ({
            id: area.id,
            name: area.name,
            slug: area.slug,
          })),
          contributors: (
            contributorsByChange.get(entry.changeId) ?? []
          ).map((contributor) => ({
            externalIdentity: contributor.externalIdentity,
            displayName: contributor.displayName,
            role: contributor.role,
            sourceUrl: contributor.sourceUrl,
          })),
          evidence: (evidenceByChange.get(entry.changeId) ?? []).map(
            (evidence) => ({
              id: evidence.id,
              kind: evidence.kind,
              externalId: evidence.externalId,
              url: evidence.url,
              sha: evidence.sha,
              path: evidence.path,
              occurredAt: evidence.occurredAt.toISOString(),
            }),
          ),
        },
      })),
    })),
  };
};
