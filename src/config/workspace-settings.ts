import { desc, isNull } from "drizzle-orm";

import type { Env } from "@/config/env.js";
import {
  applyReleaseKindAndFilePath,
  inferKindAndPathFromLegacyPaths,
  isSupportedReleaseProjectKind,
  parseReleaseProjectKind,
  type ReleaseProjectKind,
} from "@/config/release-project-kind.js";
import type { Database } from "@/db/client.js";
import { workspaceSettingsTable } from "@/db/schema.js";

export interface MergedWorkspaceSettings {
  notionPrDatabaseId: string;
  notionReleasesDatabaseId: string | null;
  prSummaryBaseBranches: string[] | null;
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

/**
 * Merges the latest `workspace_settings` row with env fallbacks (DB wins when non-blank).
 */
export const mergeWorkspaceSettings = (
  row: typeof workspaceSettingsTable.$inferSelect | undefined,
  env: Env,
): MergedWorkspaceSettings => {
  const notionPrDatabaseId = firstNonBlank(row?.notionPrDatabaseId, env.NOTION_DATABASE_ID) ?? "";
  const notionReleasesDatabaseId = firstNonBlank(
    row?.notionReleasesDatabaseId,
    env.NOTION_RELEASES_DATABASE_ID,
  );
  const releaseVersionBranch = firstNonBlank(row?.releaseVersionBranch, env.RELEASE_VERSION_BRANCH);
  const releaseMonitoredRepo = firstNonBlank(row?.releaseMonitoredRepo, env.RELEASE_MONITORED_REPO);
  const releaseCompareRootSha = firstNonBlank(row?.releaseCompareRootSha, env.RELEASE_COMPARE_ROOT_SHA);

  const unifiedKindRaw = firstNonBlank(row?.releaseProjectKind, env.RELEASE_PROJECT_KIND);
  const unifiedPathRaw = firstNonBlank(row?.releaseVersionFilePath, env.RELEASE_VERSION_FILE_PATH);

  if (unifiedKindRaw && !unifiedPathRaw) {
    throw new Error(
      "Workspace: `release_project_kind` (or RELEASE_PROJECT_KIND) is set but `release_version_file_path` (or RELEASE_VERSION_FILE_PATH) is missing. Both are required for the unified release configuration.",
    );
  }
  if (!unifiedKindRaw && unifiedPathRaw) {
    throw new Error(
      "Workspace: `release_version_file_path` (or RELEASE_VERSION_FILE_PATH) is set but `release_project_kind` (or RELEASE_PROJECT_KIND) is missing. Set the project type (e.g. react_native_expo, ios_plist).",
    );
  }

  let releaseInfoPlistPath = firstNonBlank(row?.releaseInfoPlistPath, env.RELEASE_INFO_PLIST_PATH);
  let releaseProjectPbxprojPath = firstNonBlank(
    row?.releaseProjectPbxprojPath,
    env.RELEASE_PROJECT_PBXPROJ_PATH,
  );
  let releaseExpoAppConfigPath = firstNonBlank(
    row?.releaseExpoAppConfigPath,
    env.RELEASE_EXPO_APP_CONFIG_PATH,
  );

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

  let prSummaryBaseBranches: string[] | null = null;
  const dbBranches = row?.prSummaryBaseBranches;
  if (Array.isArray(dbBranches)) {
    const cleaned = dbBranches
      .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
      .map((b) => b.trim());
    if (cleaned.length > 0) {
      prSummaryBaseBranches = cleaned;
    }
  }
  if (
    prSummaryBaseBranches === null &&
    env.PR_SUMMARY_BASE_BRANCHES &&
    env.PR_SUMMARY_BASE_BRANCHES.length > 0
  ) {
    prSummaryBaseBranches = env.PR_SUMMARY_BASE_BRANCHES;
  }

  return {
    notionPrDatabaseId,
    notionReleasesDatabaseId,
    prSummaryBaseBranches,
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
      "Notion PR database id is missing. Insert `workspace_settings` (notion_pr_database_id) or set NOTION_DATABASE_ID.",
    );
  }
  if (merged.notionReleasesDatabaseId) {
    if (!merged.releaseVersionBranch?.trim()) {
      throw new Error(
        "Release notes are enabled but release_version_branch is missing. Set workspace_settings.release_version_branch or RELEASE_VERSION_BRANCH.",
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
 * Loads the newest **global** `workspace_settings` row (`workspace_id` null) and merges with env.
 * Per-user workspace rows are ignored until the worker reads settings by workspace.
 */
export const execute = async (db: Database, env: Env): Promise<MergedWorkspaceSettings> => {
  const rows = await db
    .select()
    .from(workspaceSettingsTable)
    .where(isNull(workspaceSettingsTable.workspaceId))
    .orderBy(desc(workspaceSettingsTable.updatedAt))
    .limit(1);
  const merged = mergeWorkspaceSettings(rows[0], env);
  validateMergedWorkspaceSettings(merged);
  return merged;
};
