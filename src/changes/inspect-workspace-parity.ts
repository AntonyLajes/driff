import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import {
  changeEvidenceTable,
  changesTable,
  projectVersionsTable,
  pullRequestsTable,
  pushesTable,
  releasesTable,
  workspacesTable,
} from "@/db/schema.js";

const SOURCE_RECORD_TYPES = ["pull_requests", "pushes"] as const;

export interface SourceParity {
  legacyCount: number;
  projectedCount: number;
  missingSourceRecordIds: string[];
  coveragePercent: number;
}

export interface WorkspaceParityReport {
  workspaceId: string;
  repo: string;
  complete: boolean;
  sources: {
    pullRequests: SourceParity;
    pushes: SourceParity;
    releases: SourceParity;
  };
  canonical: {
    versions: number;
    versionedChanges: number;
    unversionedChanges: number;
  };
}

export interface ExecuteInput {
  db: Database;
  workspaceId: string;
  repo: string;
}

const normalizeRepo = (repo: string): string => repo.trim().toLowerCase();

const sourceParity = (
  legacyIds: string[],
  projectedIds: ReadonlySet<string>,
): SourceParity => {
  const missingSourceRecordIds = legacyIds.filter((id) => !projectedIds.has(id));
  const projectedCount = legacyIds.length - missingSourceRecordIds.length;

  return {
    legacyCount: legacyIds.length,
    projectedCount,
    missingSourceRecordIds,
    coveragePercent:
      legacyIds.length === 0
        ? 100
        : Math.round((projectedCount / legacyIds.length) * 10_000) / 100,
  };
};

export const execute = async (
  input: ExecuteInput,
): Promise<WorkspaceParityReport> => {
  const requestedRepo = normalizeRepo(input.repo);
  if (!requestedRepo.includes("/")) {
    throw new Error("Invalid repository: expected owner/name.");
  }

  const workspaceRows = await input.db
    .select({
      sourceProvider: workspacesTable.sourceProvider,
      repoFullName: workspacesTable.repoFullName,
    })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, input.workspaceId))
    .limit(1);
  const workspace = workspaceRows[0];
  if (workspace === undefined) {
    throw new Error(`Workspace not found: ${input.workspaceId}.`);
  }
  if (workspace.sourceProvider !== "github") {
    throw new Error(
      `Workspace source provider is ${workspace.sourceProvider}; only github is supported.`,
    );
  }
  if (normalizeRepo(workspace.repoFullName ?? "") !== requestedRepo) {
    throw new Error(
      `Workspace repository mismatch: expected ${workspace.repoFullName ?? "unlinked"}, received ${input.repo}.`,
    );
  }

  const pullRequestRows = await input.db
    .select({ id: pullRequestsTable.id })
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.repo, workspace.repoFullName!));
  const pushRows = await input.db
    .select({ id: pushesTable.id })
    .from(pushesTable)
    .where(eq(pushesTable.repo, workspace.repoFullName!));
  const releaseRows = await input.db
    .select({ id: releasesTable.id })
    .from(releasesTable)
    .where(eq(releasesTable.repo, workspace.repoFullName!));
  const evidenceRows = await input.db
    .select({
      sourceRecordType: changeEvidenceTable.sourceRecordType,
      sourceRecordId: changeEvidenceTable.sourceRecordId,
    })
    .from(changeEvidenceTable)
    .innerJoin(changesTable, eq(changeEvidenceTable.changeId, changesTable.id))
    .where(
      and(
        eq(changesTable.workspaceId, input.workspaceId),
        inArray(changeEvidenceTable.sourceRecordType, SOURCE_RECORD_TYPES),
        isNotNull(changeEvidenceTable.sourceRecordId),
      ),
    );
  const versionRows = await input.db
    .select({
      id: projectVersionsTable.id,
      sourceReleaseId: projectVersionsTable.sourceReleaseId,
    })
    .from(projectVersionsTable)
    .where(eq(projectVersionsTable.workspaceId, input.workspaceId));
  const changeRows = await input.db
    .select({ versionId: changesTable.versionId })
    .from(changesTable)
    .where(eq(changesTable.workspaceId, input.workspaceId));

  const projectedPullRequestIds = new Set<string>();
  const projectedPushIds = new Set<string>();
  for (const row of evidenceRows) {
    if (row.sourceRecordId === null) continue;
    if (row.sourceRecordType === "pull_requests") {
      projectedPullRequestIds.add(row.sourceRecordId);
    }
    if (row.sourceRecordType === "pushes") {
      projectedPushIds.add(row.sourceRecordId);
    }
  }
  const projectedReleaseIds = new Set(
    versionRows.flatMap((row) =>
      row.sourceReleaseId === null ? [] : [row.sourceReleaseId],
    ),
  );

  const pullRequests = sourceParity(
    pullRequestRows.map((row) => row.id),
    projectedPullRequestIds,
  );
  const pushes = sourceParity(
    pushRows.map((row) => row.id),
    projectedPushIds,
  );
  const releases = sourceParity(
    releaseRows.map((row) => row.id),
    projectedReleaseIds,
  );

  return {
    workspaceId: input.workspaceId,
    repo: workspace.repoFullName!,
    complete:
      pullRequests.missingSourceRecordIds.length === 0 &&
      pushes.missingSourceRecordIds.length === 0 &&
      releases.missingSourceRecordIds.length === 0,
    sources: { pullRequests, pushes, releases },
    canonical: {
      versions: versionRows.length,
      versionedChanges: changeRows.filter((row) => row.versionId !== null).length,
      unversionedChanges: changeRows.filter((row) => row.versionId === null).length,
    },
  };
};
