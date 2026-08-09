import { asc, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import {
  changeAreasTable,
  changeEvidenceTable,
  changeLineageEntriesTable,
  changesTable,
  productAreasTable,
} from "@/db/schema.js";
import {
  execute as projectChange,
  type ExecuteInput as ProjectChangeInput,
  type ProjectChangeResult,
} from "@/lineages/project-change.js";

export interface LineageBackfillCandidate {
  changeId: string;
  title: string;
  category: string;
  areaId: string | null;
  areaSlug: string | null;
  filePaths: string[];
  alreadyProjected: boolean;
}

export interface ExecuteInput {
  db: Database;
  workspaceId: string;
  apply?: boolean;
  candidateLoader?: (input: {
    db: Database;
    workspaceId: string;
  }) => Promise<LineageBackfillCandidate[]>;
  projector?: (input: ProjectChangeInput) => Promise<ProjectChangeResult>;
}

export interface LineageBackfillResult {
  mode: "dry_run" | "apply";
  candidates: number;
  alreadyProjected: number;
  ready: number;
  projected: number;
  linkedExisting: number;
  created: number;
  skipped: Array<{
    changeId: string;
    reason: "missing_area" | "insufficient_identity";
  }>;
}

export const loadCandidates = async (input: {
  db: Database;
  workspaceId: string;
}): Promise<LineageBackfillCandidate[]> => {
  const changeRows = await input.db
    .select({
      changeId: changesTable.id,
      title: changesTable.title,
      category: changesTable.category,
      areaId: productAreasTable.id,
      areaSlug: productAreasTable.slug,
    })
    .from(changesTable)
    .leftJoin(changeAreasTable, eq(changeAreasTable.changeId, changesTable.id))
    .leftJoin(
      productAreasTable,
      eq(changeAreasTable.areaId, productAreasTable.id),
    )
    .where(eq(changesTable.workspaceId, input.workspaceId))
    .orderBy(
      asc(changesTable.lastOccurredAt),
      asc(changesTable.id),
      asc(productAreasTable.slug),
    );
  const changeIds = Array.from(new Set(changeRows.map((row) => row.changeId)));
  if (changeIds.length === 0) return [];

  const [evidenceRows, membershipRows] = await Promise.all([
    input.db
      .select({
        changeId: changeEvidenceTable.changeId,
        path: changeEvidenceTable.path,
      })
      .from(changeEvidenceTable)
      .where(inArray(changeEvidenceTable.changeId, changeIds)),
    input.db
      .select({ changeId: changeLineageEntriesTable.changeId })
      .from(changeLineageEntriesTable)
      .where(inArray(changeLineageEntriesTable.changeId, changeIds)),
  ]);
  const pathsByChange = new Map<string, string[]>();
  for (const row of evidenceRows) {
    if (row.path === null) continue;
    const paths = pathsByChange.get(row.changeId) ?? [];
    if (!paths.includes(row.path)) paths.push(row.path);
    pathsByChange.set(row.changeId, paths);
  }
  const projectedChangeIds = new Set(
    membershipRows.map((row) => row.changeId),
  );
  const candidateByChange = new Map<string, LineageBackfillCandidate>();
  for (const row of changeRows) {
    if (candidateByChange.has(row.changeId)) continue;
    candidateByChange.set(row.changeId, {
      changeId: row.changeId,
      title: row.title,
      category: row.category,
      areaId: row.areaId,
      areaSlug: row.areaSlug,
      filePaths: pathsByChange.get(row.changeId) ?? [],
      alreadyProjected: projectedChangeIds.has(row.changeId),
    });
  }
  return Array.from(candidateByChange.values());
};

export const execute = async (
  input: ExecuteInput,
): Promise<LineageBackfillResult> => {
  const candidates = await (input.candidateLoader ?? loadCandidates)({
    db: input.db,
    workspaceId: input.workspaceId,
  });
  const result: LineageBackfillResult = {
    mode: input.apply === true ? "apply" : "dry_run",
    candidates: candidates.length,
    alreadyProjected: 0,
    ready: 0,
    projected: 0,
    linkedExisting: 0,
    created: 0,
    skipped: [],
  };

  for (const candidate of candidates) {
    if (candidate.alreadyProjected) {
      result.alreadyProjected += 1;
      continue;
    }
    if (candidate.areaId === null || candidate.areaSlug === null) {
      result.skipped.push({
        changeId: candidate.changeId,
        reason: "missing_area",
      });
      continue;
    }
    result.ready += 1;
    if (input.apply !== true) continue;

    const projected = await (input.projector ?? projectChange)({
      db: input.db,
      workspaceId: input.workspaceId,
      changeId: candidate.changeId,
      title: candidate.title,
      category: candidate.category,
      areaId: candidate.areaId,
      areaSlug: candidate.areaSlug,
      filePaths: candidate.filePaths,
    });
    if (projected.kind === "unassigned") {
      result.skipped.push({
        changeId: candidate.changeId,
        reason: projected.reason,
      });
      continue;
    }
    result.projected += 1;
    if (projected.matchedExisting) result.linkedExisting += 1;
    else result.created += 1;
  }

  return result;
};
