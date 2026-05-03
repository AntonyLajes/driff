import { desc } from "drizzle-orm";

import type { Env } from "@/config/env.js";
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
  const releaseInfoPlistPath = firstNonBlank(row?.releaseInfoPlistPath, env.RELEASE_INFO_PLIST_PATH);
  const releaseVersionBranch = firstNonBlank(row?.releaseVersionBranch, env.RELEASE_VERSION_BRANCH);
  const releaseMonitoredRepo = firstNonBlank(row?.releaseMonitoredRepo, env.RELEASE_MONITORED_REPO);
  const releaseProjectPbxprojPath = firstNonBlank(
    row?.releaseProjectPbxprojPath,
    env.RELEASE_PROJECT_PBXPROJ_PATH,
  );
  const releaseCompareRootSha = firstNonBlank(row?.releaseCompareRootSha, env.RELEASE_COMPARE_ROOT_SHA);
  const releaseExpoAppConfigPath = firstNonBlank(
    row?.releaseExpoAppConfigPath,
    env.RELEASE_EXPO_APP_CONFIG_PATH,
  );

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
        "Release notes are enabled but no version source is configured. Set one of: workspace_settings.release_info_plist_path (RELEASE_INFO_PLIST_PATH), release_project_pbxproj_path (RELEASE_PROJECT_PBXPROJ_PATH), or release_expo_app_config_path (RELEASE_EXPO_APP_CONFIG_PATH) for Expo / React Native.",
      );
    }
  }
};

/**
 * Loads the newest `workspace_settings` row and merges with env (secrets are never stored here).
 */
export const execute = async (db: Database, env: Env): Promise<MergedWorkspaceSettings> => {
  const rows = await db
    .select()
    .from(workspaceSettingsTable)
    .orderBy(desc(workspaceSettingsTable.updatedAt))
    .limit(1);
  const merged = mergeWorkspaceSettings(rows[0], env);
  validateMergedWorkspaceSettings(merged);
  return merged;
};
