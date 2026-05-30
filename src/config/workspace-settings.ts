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

export interface MergedWorkspaceSettings {
  notionPrDatabaseId: string;
  notionReleasesDatabaseId: string | null;
  notionPushesDatabaseId: string | null;
  prSummaryBaseBranches: string[] | null;
  pushSummaryBranches: string[] | null;
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

const firstNonBlank = (...candidates: ReadonlyArray<string | null | undefined>): string | null => {
  for (const raw of candidates) {
    const t = raw?.trim();
    if (t && t.length > 0) {
      return t;
    }
  }
  return null;
};

/** Builds normalized runtime settings from a workspace_settings row only (no env fallback). */
export const mergeWorkspaceSettingsRow = (
  row: typeof workspaceSettingsTable.$inferSelect,
): MergedWorkspaceSettings => {
  const notionPrDatabaseId = firstNonBlank(row.notionPrDatabaseId) ?? "";
  const notionReleasesDatabaseId = firstNonBlank(row.notionReleasesDatabaseId);
  const notionPushesDatabaseId = firstNonBlank(row.notionPushesDatabaseId);
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
        `Workspace: release_project_kind "${kind}" is not supported yet. Use ios_plist, ios_pbx, or react_native_expo.`,
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

  return {
    notionPrDatabaseId,
    notionReleasesDatabaseId,
    notionPushesDatabaseId,
    prSummaryBaseBranches,
    pushSummaryBranches,
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

export const validateMergedWorkspaceSettings = (merged: MergedWorkspaceSettings): void => {
  if (!merged.notionPrDatabaseId.trim()) {
    throw new Error(
      "Notion PR database id is missing. Set workspace_settings.notion_pr_database_id for this workspace.",
    );
  }
  if (merged.notionReleasesDatabaseId) {
    if (!merged.releaseVersionBranch?.trim()) {
      throw new Error(
        "Release notes are enabled but release_version_branch is missing in workspace_settings.",
      );
    }
    const hasVersionSource =
      Boolean(merged.releaseInfoPlistPath?.trim()) ||
      Boolean(merged.releaseProjectPbxprojPath?.trim()) ||
      Boolean(merged.releaseExpoAppConfigPath?.trim());
    if (!hasVersionSource) {
      throw new Error(
        "Release notes are enabled but no version source is configured. Prefer workspace_settings.release_project_kind + release_version_file_path (e.g. react_native_expo and app.json), or set release_info_plist_path, release_project_pbxproj_path, or release_expo_app_config_path.",
      );
    }
  }
};

/**
 * Strict (provider, repo)->workspace resolver used in webhook/job runtime.
 * No global row and no env fallback: if workspace or settings are missing, returns null.
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
  if (settingsRow === undefined) {
    return null;
  }

  const merged = mergeWorkspaceSettingsRow(settingsRow);
  merged.repoDefaultBranch = repoDefaultBranch;
  validateMergedWorkspaceSettings(merged);
  return merged;
};
