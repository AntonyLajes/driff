import { and, desc, eq, inArray, ne } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import {
  changeAreasTable,
  changeEvidenceTable,
  changeLineageEntriesTable,
  changeLineagesTable,
  changesTable,
} from "@/db/schema.js";
import {
  buildSuggestedLineageKey,
  fingerprintChange,
  scoreFingerprintMatch,
  shouldAutoLink,
  suggestRelation,
} from "@/lineages/match-candidate.js";
import {
  execute as upsertMembership,
  type ExecuteInput as UpsertMembershipInput,
} from "@/lineages/upsert-membership.js";

export interface ExecuteInput {
  db: Database;
  workspaceId: string;
  changeId: string;
  title: string;
  category: string;
  areaId: string;
  areaSlug: string;
  filePaths: string[];
  membershipWriter?: (
    input: UpsertMembershipInput,
  ) => Promise<{ lineageId: string; lineageKey: string }>;
}

type CandidateRow = {
  lineageId: string;
  lineageKey: string;
  lineageTitle: string;
  lineageSource: "rule" | "ai" | "human";
  lineageConfidence: number | null;
  changeId: string;
  title: string;
  category: string;
};

export type ProjectChangeResult =
  | {
      kind: "projected";
      lineageId: string;
      lineageKey: string;
      relationType: ReturnType<typeof suggestRelation>;
      matchedExisting: boolean;
      matchScore: number | null;
    }
  | { kind: "unassigned"; reason: "insufficient_identity" };

export const execute = async (
  input: ExecuteInput,
): Promise<ProjectChangeResult> => {
  const currentFingerprint = fingerprintChange({
    title: input.title,
    category: input.category,
    areaSlugs: [input.areaSlug],
    filePaths: input.filePaths,
  });
  const suggestedKey = buildSuggestedLineageKey(currentFingerprint);
  if (suggestedKey === null) {
    return { kind: "unassigned", reason: "insufficient_identity" };
  }

  const candidateRows = (await input.db
    .select({
      lineageId: changeLineagesTable.id,
      lineageKey: changeLineagesTable.key,
      lineageTitle: changeLineagesTable.title,
      lineageSource: changeLineagesTable.source,
      lineageConfidence: changeLineagesTable.confidence,
      changeId: changesTable.id,
      title: changesTable.title,
      category: changesTable.category,
    })
    .from(changeLineageEntriesTable)
    .innerJoin(
      changeLineagesTable,
      eq(changeLineageEntriesTable.lineageId, changeLineagesTable.id),
    )
    .innerJoin(
      changesTable,
      eq(changeLineageEntriesTable.changeId, changesTable.id),
    )
    .innerJoin(changeAreasTable, eq(changeAreasTable.changeId, changesTable.id))
    .where(
      and(
        eq(changeLineagesTable.workspaceId, input.workspaceId),
        ne(changeLineagesTable.status, "merged"),
        eq(changeAreasTable.areaId, input.areaId),
        ne(changesTable.id, input.changeId),
      ),
    )
    .orderBy(desc(changeLineageEntriesTable.occurredAt))
    .limit(50)) as CandidateRow[];

  const candidateChangeIds = Array.from(
    new Set(candidateRows.map((candidate) => candidate.changeId)),
  );
  const pathRows =
    candidateChangeIds.length === 0
      ? []
      : await input.db
          .select({
            changeId: changeEvidenceTable.changeId,
            path: changeEvidenceTable.path,
          })
          .from(changeEvidenceTable)
          .where(
            and(
              inArray(changeEvidenceTable.changeId, candidateChangeIds),
              eq(changeEvidenceTable.kind, "file"),
            ),
          );
  const pathsByChange = new Map<string, string[]>();
  for (const row of pathRows) {
    if (row.path === null) continue;
    const paths = pathsByChange.get(row.changeId) ?? [];
    paths.push(row.path);
    pathsByChange.set(row.changeId, paths);
  }

  const scored = candidateRows.map((candidate) => ({
    candidate,
    score: scoreFingerprintMatch(
      fingerprintChange({
        title: candidate.title,
        category: candidate.category,
        areaSlugs: [input.areaSlug],
        filePaths: pathsByChange.get(candidate.changeId) ?? [],
      }),
      currentFingerprint,
    ),
  }));
  scored.sort((left, right) => right.score - left.score);
  const best = scored[0];
  const matchedExisting = best !== undefined && shouldAutoLink(best.score);
  const relationType = suggestRelation(
    { title: input.title, category: input.category },
    matchedExisting,
  );
  const writer = input.membershipWriter ?? upsertMembership;
  const result = await writer({
    db: input.db,
    workspaceId: input.workspaceId,
    changeId: input.changeId,
    lineage: matchedExisting
      ? {
          key: best.candidate.lineageKey,
          title: best.candidate.lineageTitle,
          source: best.candidate.lineageSource,
          confidence: best.candidate.lineageConfidence,
        }
      : {
          key: suggestedKey,
          title: input.title,
          source: "rule",
          confidence: 70,
        },
    relationType,
    assignmentSource: "rule",
    assignmentConfidence: matchedExisting ? best.score : 70,
  });

  return {
    kind: "projected",
    ...result,
    relationType,
    matchedExisting,
    matchScore: matchedExisting ? best.score : null,
  };
};
