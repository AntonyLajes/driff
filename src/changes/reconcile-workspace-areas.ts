import { and, eq } from "drizzle-orm";

import { execute as buildCanonicalId } from "@/changes/canonical-id.js";
import { normalizeProductArea } from "@/changes/normalize-product-area.js";
import type { Database } from "@/db/client.js";
import {
  changeAreasTable,
  changeEvidenceTable,
  changesTable,
  productAreasTable,
  pullRequestsTable,
  pushesTable,
} from "@/db/schema.js";

export interface AreaCandidate {
  changeId: string;
  rawArea: string | null;
}

export interface CurrentAreaAssignment {
  changeId: string;
  slug: string;
}

export interface AreaReconciliationItem {
  changeId: string;
  rawArea: string | null;
  currentSlugs: string[];
  target: ReturnType<typeof normalizeProductArea>;
  changed: boolean;
}

export interface ReconcileWorkspaceAreasResult {
  mode: "dry_run" | "apply";
  candidates: number;
  changed: number;
  unchanged: number;
  removed: number;
  targets: Record<string, number>;
}

export const summarizeAreaReconciliationPlan = (
  plan: AreaReconciliationItem[],
  apply: boolean,
): ReconcileWorkspaceAreasResult => {
  const changedItems = plan.filter((item) => item.changed);
  const targets: Record<string, number> = {};
  for (const item of plan) {
    if (item.target !== null) {
      targets[item.target.slug] = (targets[item.target.slug] ?? 0) + 1;
    }
  }
  return {
    mode: apply ? "apply" : "dry_run",
    candidates: plan.length,
    changed: changedItems.length,
    unchanged: plan.length - changedItems.length,
    removed: changedItems.filter((item) => item.target === null).length,
    targets,
  };
};

const sameSlugs = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((slug, index) => slug === right[index]);

export const buildAreaReconciliationPlan = (
  candidates: AreaCandidate[],
  currentAssignments: CurrentAreaAssignment[],
): AreaReconciliationItem[] => {
  const currentByChange = new Map<string, string[]>();
  for (const assignment of currentAssignments) {
    const current = currentByChange.get(assignment.changeId) ?? [];
    if (!current.includes(assignment.slug)) current.push(assignment.slug);
    currentByChange.set(assignment.changeId, current);
  }

  const candidateByChange = new Map<string, AreaCandidate>();
  for (const candidate of candidates) {
    if (!candidateByChange.has(candidate.changeId)) {
      candidateByChange.set(candidate.changeId, candidate);
    }
  }

  return [...candidateByChange.values()]
    .map((candidate) => {
      const currentSlugs = [...(currentByChange.get(candidate.changeId) ?? [])].sort();
      const target = normalizeProductArea(candidate.rawArea);
      const targetSlugs = target === null ? [] : [target.slug];
      return {
        ...candidate,
        currentSlugs,
        target,
        changed: !sameSlugs(currentSlugs, targetSlugs),
      };
    })
    .sort((left, right) => left.changeId.localeCompare(right.changeId));
};

const loadCandidates = async (
  db: Database,
  workspaceId: string,
): Promise<AreaCandidate[]> => {
  const prCandidates = await db
    .selectDistinct({
      changeId: changesTable.id,
      rawArea: pullRequestsTable.area,
    })
    .from(changesTable)
    .innerJoin(
      changeEvidenceTable,
      eq(changeEvidenceTable.changeId, changesTable.id),
    )
    .innerJoin(
      pullRequestsTable,
      and(
        eq(changeEvidenceTable.sourceRecordType, "pull_requests"),
        eq(changeEvidenceTable.sourceRecordId, pullRequestsTable.id),
      ),
    )
    .where(eq(changesTable.workspaceId, workspaceId));
  const pushCandidates = await db
    .selectDistinct({
      changeId: changesTable.id,
      rawArea: pushesTable.area,
    })
    .from(changesTable)
    .innerJoin(
      changeEvidenceTable,
      eq(changeEvidenceTable.changeId, changesTable.id),
    )
    .innerJoin(
      pushesTable,
      and(
        eq(changeEvidenceTable.sourceRecordType, "pushes"),
        eq(changeEvidenceTable.sourceRecordId, pushesTable.id),
      ),
    )
    .where(eq(changesTable.workspaceId, workspaceId));
  return [...prCandidates, ...pushCandidates];
};

const loadCurrentAssignments = async (
  db: Database,
  workspaceId: string,
): Promise<CurrentAreaAssignment[]> =>
  db
    .select({
      changeId: changeAreasTable.changeId,
      slug: productAreasTable.slug,
    })
    .from(changeAreasTable)
    .innerJoin(changesTable, eq(changeAreasTable.changeId, changesTable.id))
    .innerJoin(
      productAreasTable,
      eq(changeAreasTable.areaId, productAreasTable.id),
    )
    .where(
      and(
        eq(changesTable.workspaceId, workspaceId),
        eq(changeAreasTable.source, "ai"),
      ),
    );

export const execute = async (input: {
  db: Database;
  workspaceId: string;
  apply?: boolean;
}): Promise<ReconcileWorkspaceAreasResult> => {
  const [candidates, currentAssignments] = await Promise.all([
    loadCandidates(input.db, input.workspaceId),
    loadCurrentAssignments(input.db, input.workspaceId),
  ]);
  const plan = buildAreaReconciliationPlan(candidates, currentAssignments);
  const changedItems = plan.filter((item) => item.changed);

  if (input.apply === true) {
    for (const item of changedItems) {
      await input.db.transaction(async (tx) => {
        await tx
          .delete(changeAreasTable)
          .where(
            and(
              eq(changeAreasTable.changeId, item.changeId),
              eq(changeAreasTable.source, "ai"),
            ),
          );
        if (item.target === null) return;

        const areaId = buildCanonicalId(
          "product-area",
          input.workspaceId,
          item.target.slug,
        );
        await tx
          .insert(productAreasTable)
          .values({
            id: areaId,
            workspaceId: input.workspaceId,
            name: item.target.name,
            slug: item.target.slug,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [productAreasTable.workspaceId, productAreasTable.slug],
            set: { name: item.target.name, updatedAt: new Date() },
          });
        await tx
          .insert(changeAreasTable)
          .values({ changeId: item.changeId, areaId, source: "ai" })
          .onConflictDoUpdate({
            target: [changeAreasTable.changeId, changeAreasTable.areaId],
            set: { source: "ai" },
          });
      });
    }
  }

  return summarizeAreaReconciliationPlan(plan, input.apply === true);
};
