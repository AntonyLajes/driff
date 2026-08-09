import { and, eq, inArray, isNull } from "drizzle-orm";

import { execute as buildCanonicalId } from "@/changes/canonical-id.js";
import type { Database } from "@/db/client.js";
import {
  changeEvidenceTable,
  changesTable,
  projectVersionsTable,
} from "@/db/schema.js";
import type { ReleaseChangelogNotes } from "@/llm/release-summarizer.js";
import type { ReleaseVersionStrategy } from "@/config/release-version-strategy.js";

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
  promptVersion: number | null;
  beforeSha: string;
  headSha: string;
  compareUrl: string;
  prNumbers: number[];
  commitShas: string[];
  releasedAt: Date;
  strategy?: ReleaseVersionStrategy;
  sourceRef?: string;
  previousSourceRef?: string | null;
  sourceUrl?: string | null;
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

export const execute = ({ db }: ExecuteInput): ReleaseProjector => ({
  project: async (input) =>
    db.transaction(async (tx) => {
      const strategy = input.strategy ?? "version_file";
      const sourceRef = input.sourceRef?.trim() || input.versionKey;
      const sourceUrl = input.sourceUrl === undefined ? input.compareUrl : input.sourceUrl;
      let previousVersionId: string | null = null;
      const previousSourceRef =
        input.previousSourceRef === undefined
          ? input.previousVersionKey
          : input.previousSourceRef;
      if (previousSourceRef !== null) {
        const previousRows = await tx
          .select({ id: projectVersionsTable.id })
          .from(projectVersionsTable)
          .where(
            and(
              eq(projectVersionsTable.workspaceId, input.workspaceId),
              eq(projectVersionsTable.strategy, strategy),
              eq(projectVersionsTable.sourceRef, previousSourceRef),
            ),
          )
          .limit(1);
        previousVersionId = previousRows[0]?.id ?? null;
      }

      const now = new Date();
      const proposedVersionId = buildCanonicalId(
        "project-version",
        input.workspaceId,
        strategy,
        sourceRef,
      );
      const versionRows = await tx
        .insert(projectVersionsTable)
        .values({
          id: proposedVersionId,
          workspaceId: input.workspaceId,
          displayVersion: input.shortVersion,
          normalizedVersion: input.versionKey,
          buildVersion: input.buildVersion.trim() || null,
          title: input.title,
          changelog: input.changelog,
          sections: input.sections,
          promptVersion: input.promptVersion,
          status: "released",
          strategy,
          sourceRef,
          sourceUrl,
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
            buildVersion: input.buildVersion.trim() || null,
            title: input.title,
            changelog: input.changelog,
            sections: input.sections,
            promptVersion: input.promptVersion,
            status: "released",
            sourceUrl,
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
      const commitSourceKeys = input.commitShas.map(
        (commitSha) =>
          `github:${input.repo.trim().toLowerCase()}:commit:${commitSha}`,
      );
      const changeSourceKeys = [...prSourceKeys, ...commitSourceKeys];
      if (changeSourceKeys.length === 0) {
        return { versionId, linkedChangeIds: [] };
      }

      const projectedChanges = tx
        .select({ id: changeEvidenceTable.changeId })
        .from(changeEvidenceTable)
        .where(inArray(changeEvidenceTable.sourceKey, changeSourceKeys));

      const linkedRows = await tx
        .update(changesTable)
        .set({ versionId, updatedAt: now })
        .where(
          and(
            eq(changesTable.workspaceId, input.workspaceId),
            isNull(changesTable.versionId),
            inArray(changesTable.id, projectedChanges),
          ),
        )
        .returning({ id: changesTable.id });

      return { versionId, linkedChangeIds: linkedRows.map((row) => row.id) };
    }),
});
