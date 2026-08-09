import { and, eq } from "drizzle-orm";
import {
  applyReleaseKindAndFilePath,
  inferKindAndPathFromLegacyPaths,
  isSupportedReleaseProjectKind,
  parseReleaseProjectKind,
  type ReleaseProjectKind,
} from "@/config/release-project-kind.js";
import type { Database } from "@/db/client.js";
import { workspaceSettingsTable, workspacesTable } from "@/db/schema.js";
import {
  cleanHistoryFilterValues,
  DEFAULT_HISTORY_EXCLUDED_PATHS,
} from "@/config/history-content-filter.js";

export interface MergedWorkspaceSettings {
  /** Id of the workspace this config belongs to (used to load output destinations). */
  workspaceId: string;
  prSummaryBaseBranches: string[] | null;
  pushSummaryBranches: string[] | null;
  historyExcludedPaths: string[];
  historyExcludedActors: string[];
  /** Repo default branch from the linked workspace; used as push-summary branch fallback. */
  repoDefaultBranch: string | null;
  releaseInfoPlistPath: string | null;
  releaseVersionBranch: string | null;
  releaseMonitoredRepo: string | null;
  releaseProjectPbxprojPath: string | null;
  releaseExpoAppConfigPath: string | null;
  releaseCompareRootSha: string | null;
  /**
   * Modelo unificado para onboarding: tipo de app + um único ficheiro de versão.
   * Preenchido a partir de `release_project_kind` + `release_version_file_path` ou inferido dos campos legados.
   */
  releaseProjectKind: ReleaseProjectKind | null;
  releaseVersionFilePath: string | null;
}

/** True when the workspace has a release version source configured (release notes can run). */
export const hasReleaseVersionSource = (merged: MergedWorkspaceSettings): boolean =>
  Boolean(merged.releaseProjectKind) && Boolean(merged.releaseVersionFilePath?.trim());

const firstNonBlank = (...candidates: ReadonlyArray<string | null | undefined>): string | null => {
  for (const raw of candidates) {
    const t = raw?.trim();
    if (t && t.length > 0) {
      return t;
    }
  }
  return null;
};

const emptyMergedSettings = (workspaceId: string): MergedWorkspaceSettings => ({
  workspaceId,
  prSummaryBaseBranches: null,
  pushSummaryBranches: null,
  historyExcludedPaths: [...DEFAULT_HISTORY_EXCLUDED_PATHS],
  historyExcludedActors: [],
  repoDefaultBranch: null,
  releaseInfoPlistPath: null,
  releaseVersionBranch: null,
  releaseMonitoredRepo: null,
  releaseProjectPbxprojPath: null,
  releaseExpoAppConfigPath: null,
  releaseCompareRootSha: null,
  releaseProjectKind: null,
  releaseVersionFilePath: null,
});

/** Builds normalized runtime settings from a workspace_settings row (no env fallback). */
export const mergeWorkspaceSettingsRow = (
  row: typeof workspaceSettingsTable.$inferSelect,
): MergedWorkspaceSettings => {
  const releaseVersionBranch = firstNonBlank(row.releaseVersionBranch);
  const releaseMonitoredRepo = firstNonBlank(row.releaseMonitoredRepo);
  const releaseCompareRootSha = firstNonBlank(row.releaseCompareRootSha);

  const unifiedKindRaw = firstNonBlank(row.releaseProjectKind);
  const unifiedPathRaw = firstNonBlank(row.releaseVersionFilePath);

  if (unifiedKindRaw && !unifiedPathRaw) {
    throw new Error(
      "Workspace: `release_project_kind` is set but `release_version_file_path` is missing.",
    );
  }
  if (!unifiedKindRaw && unifiedPathRaw) {
    throw new Error(
      "Workspace: `release_version_file_path` is set but `release_project_kind` is missing.",
    );
  }

  let releaseInfoPlistPath = firstNonBlank(row.releaseInfoPlistPath);
  let releaseProjectPbxprojPath = firstNonBlank(row.releaseProjectPbxprojPath);
  let releaseExpoAppConfigPath = firstNonBlank(row.releaseExpoAppConfigPath);

  let releaseProjectKind: ReleaseProjectKind | null = null;
  let releaseVersionFilePath: string | null = null;

  if (unifiedKindRaw && unifiedPathRaw) {
    const kind = parseReleaseProjectKind(unifiedKindRaw);
    if (!isSupportedReleaseProjectKind(kind)) {
      throw new Error(
        `Workspace: release_project_kind "${kind}" is not supported yet. Use ios_plist, ios_pbx, react_native_expo, or node_package.`,
      );
    }
    const applied = applyReleaseKindAndFilePath(kind, unifiedPathRaw);
    releaseInfoPlistPath = applied.releaseInfoPlistPath;
    releaseProjectPbxprojPath = applied.releaseProjectPbxprojPath;
    releaseExpoAppConfigPath = applied.releaseExpoAppConfigPath;
    releaseProjectKind = kind;
    releaseVersionFilePath = unifiedPathRaw.trim();
  } else {
    const inferred = inferKindAndPathFromLegacyPaths(
      releaseInfoPlistPath,
      releaseProjectPbxprojPath,
      releaseExpoAppConfigPath,
    );
    if (inferred) {
      releaseProjectKind = inferred.kind;
      releaseVersionFilePath = inferred.path;
    }
  }

  const cleanBranchList = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) {
      return null;
    }
    const cleaned = value
      .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
      .map((b) => b.trim());
    return cleaned.length > 0 ? cleaned : null;
  };

  const prSummaryBaseBranches = cleanBranchList(row.prSummaryBaseBranches);
  const pushSummaryBranches = cleanBranchList(row.pushSummaryBranches);
  const historyExcludedPaths =
    cleanHistoryFilterValues(row.historyExcludedPaths) ?? [...DEFAULT_HISTORY_EXCLUDED_PATHS];
  const historyExcludedActors = cleanHistoryFilterValues(row.historyExcludedActors) ?? [];

  return {
    workspaceId: row.workspaceId ?? "",
    prSummaryBaseBranches,
    pushSummaryBranches,
    historyExcludedPaths,
    historyExcludedActors,
    repoDefaultBranch: null,
    releaseInfoPlistPath,
    releaseVersionBranch,
    releaseMonitoredRepo,
    releaseProjectPbxprojPath,
    releaseExpoAppConfigPath,
    releaseCompareRootSha,
    releaseProjectKind,
    releaseVersionFilePath,
  };
};

/**
 * Strict (provider, repo)->workspace resolver used in webhook/job runtime.
 * Returns null only when no workspace is linked to the repo. A workspace with no
 * `workspace_settings` row still resolves (PR summaries work with just a destination);
 * release/push config defaults to empty. Output destinations are loaded separately.
 */
export const resolveWorkspaceSettingsForRepo = async (
  db: Database,
  sourceProvider: string,
  repoFullName: string,
): Promise<MergedWorkspaceSettings | null> => {
  const normalized = repoFullName.trim();
  const provider = sourceProvider.trim();
  if (normalized.length === 0 || provider.length === 0) {
    return null;
  }

  const workspaceRows = await db
    .select({
      id: workspacesTable.id,
      repoDefaultBranch: workspacesTable.repoDefaultBranch,
    })
    .from(workspacesTable)
    .where(
      and(
        eq(workspacesTable.sourceProvider, provider),
        eq(workspacesTable.repoFullName, normalized),
      ),
    )
    .limit(1);
  const workspaceId = workspaceRows[0]?.id;
  if (workspaceId === undefined) {
    return null;
  }
  const repoDefaultBranch = workspaceRows[0]?.repoDefaultBranch ?? null;

  const settingsRows = await db
    .select()
    .from(workspaceSettingsTable)
    .where(eq(workspaceSettingsTable.workspaceId, workspaceId))
    .limit(1);
  const settingsRow = settingsRows[0];

  const merged =
    settingsRow === undefined
      ? emptyMergedSettings(workspaceId)
      : mergeWorkspaceSettingsRow(settingsRow);
  merged.workspaceId = workspaceId;
  merged.repoDefaultBranch = repoDefaultBranch;
  return merged;
};
