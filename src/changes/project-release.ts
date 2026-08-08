import { and, eq, inArray, isNull } from "drizzle-orm";

import { execute as buildCanonicalId } from "@/changes/canonical-id.js";
import type { Database } from "@/db/client.js";
import {
  changeEvidenceTable,
  changesTable,
  projectVersionsTable,
} from "@/db/schema.js";
import type { ReleaseChangelogNotes } from "@/llm/release-summarizer.js";

export interface ReleaseProjectionInput {
  workspaceId: string;
  sourceReleaseId: string;
  repo: string;
  versionKey: string;
  previousVersionKey: string | null;
  shortVersion: string;
  buildVersion: string;
  title: string;
  changelog: string;
  sections: ReleaseChangelogNotes["sections"];
  promptVersion: number;
  beforeSha: string;
  headSha: string;
  compareUrl: string;
  prNumbers: number[];
  releasedAt: Date;
}

export interface ReleaseProjectionResult {
  versionId: string;
  linkedChangeIds: string[];
}

export interface ReleaseProjector {
  project: (input: ReleaseProjectionInput) => Promise<ReleaseProjectionResult>;
}

export interface ExecuteInput {
  db: Database;
}

const VERSION_STRATEGY = "version_file";

export const execute = ({ db }: ExecuteInput): ReleaseProjector => ({
  project: async (input) =>
    db.transaction(async (tx) => {
      let previousVersionId: string | null = null;
      if (input.previousVersionKey !== null) {
        const previousRows = await tx
          .select({ id: projectVersionsTable.id })
          .from(projectVersionsTable)
          .where(
            and(
              eq(projectVersionsTable.workspaceId, input.workspaceId),
              eq(projectVersionsTable.strategy, VERSION_STRATEGY),
              eq(projectVersionsTable.sourceRef, input.previousVersionKey),
            ),
          )
          .limit(1);
        previousVersionId = previousRows[0]?.id ?? null;
      }

      const now = new Date();
      const proposedVersionId = buildCanonicalId(
        "project-version",
        input.workspaceId,
        VERSION_STRATEGY,
        input.versionKey,
      );
      const versionRows = await tx
        .insert(projectVersionsTable)
        .values({
          id: proposedVersionId,
          workspaceId: input.workspaceId,
          displayVersion: input.shortVersion,
          normalizedVersion: input.versionKey,
          buildVersion: input.buildVersion,
          title: input.title,
          changelog: input.changelog,
          sections: input.sections,
          promptVersion: input.promptVersion,
          status: "released",
          strategy: VERSION_STRATEGY,
          sourceRef: input.versionKey,
          sourceUrl: input.compareUrl,
          sourceReleaseId: input.sourceReleaseId,
          previousVersionId,
          beforeSha: input.beforeSha,
          headSha: input.headSha,
          releasedAt: input.releasedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            projectVersionsTable.workspaceId,
            projectVersionsTable.strategy,
            projectVersionsTable.sourceRef,
          ],
          set: {
            displayVersion: input.shortVersion,
            normalizedVersion: input.versionKey,
            buildVersion: input.buildVersion,
            title: input.title,
            changelog: input.changelog,
            sections: input.sections,
            promptVersion: input.promptVersion,
            status: "released",
            sourceUrl: input.compareUrl,
            sourceReleaseId: input.sourceReleaseId,
            previousVersionId,
            beforeSha: input.beforeSha,
            headSha: input.headSha,
            releasedAt: input.releasedAt,
            updatedAt: now,
          },
        })
        .returning({ id: projectVersionsTable.id });

      const versionId = versionRows[0]?.id;
      if (versionId === undefined) {
        throw new Error("Project version upsert did not return an id.");
      }

      const prSourceKeys = input.prNumbers.map(
        (prNumber) =>
          `github:${input.repo.trim().toLowerCase()}:pull_request:${prNumber}`,
      );
      if (prSourceKeys.length === 0) {
        return { versionId, linkedChangeIds: [] };
      }

      const projectedPrChanges = tx
        .select({ id: changeEvidenceTable.changeId })
        .from(changeEvidenceTable)
        .where(
          and(
            eq(changeEvidenceTable.kind, "pull_request"),
            inArray(changeEvidenceTable.sourceKey, prSourceKeys),
          ),
        );

      const linkedRows = await tx
        .update(changesTable)
        .set({ versionId, updatedAt: now })
        .where(
          and(
            eq(changesTable.workspaceId, input.workspaceId),
            isNull(changesTable.versionId),
            inArray(changesTable.id, projectedPrChanges),
          ),
        )
        .returning({ id: changesTable.id });

      return { versionId, linkedChangeIds: linkedRows.map((row) => row.id) };
    }),
});
