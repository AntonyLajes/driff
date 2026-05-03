import { describe, expect, it, vi } from "vitest";

import { execute as parseEnv } from "@/config/env.js";
import {
  execute as loadWorkspaceSettings,
  mergeWorkspaceSettings,
  validateMergedWorkspaceSettings,
} from "@/config/workspace-settings.js";
import type { workspaceSettingsTable } from "@/db/schema.js";

const buildEnv = (overrides: Record<string, string | undefined> = {}) =>
  parseEnv({
    DATABASE_URL: "postgres://user:pass@localhost:5432/driff",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    ANTHROPIC_API_KEY: "anthropic-key",
    NOTION_TOKEN: "notion-token",
    NOTION_DATABASE_ID: "notion-database-id",
    ...overrides,
  });

const row = (
  partial: Partial<typeof workspaceSettingsTable.$inferSelect>,
): typeof workspaceSettingsTable.$inferSelect =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    notionPrDatabaseId: null,
    notionReleasesDatabaseId: null,
    releaseInfoPlistPath: null,
    releaseVersionBranch: null,
    releaseMonitoredRepo: null,
    releaseProjectPbxprojPath: null,
    releaseExpoAppConfigPath: null,
    releaseCompareRootSha: null,
    prSummaryBaseBranches: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  }) as typeof workspaceSettingsTable.$inferSelect;

describe("config/workspace-settings mergeWorkspaceSettings", () => {
  it("should prefer database notion_pr_database_id over env", () => {
    const merged = mergeWorkspaceSettings(row({ notionPrDatabaseId: "from-db" }), buildEnv());
    expect(merged.notionPrDatabaseId).toBe("from-db");
  });

  it("should fall back to env when row omits notion_pr_database_id", () => {
    const merged = mergeWorkspaceSettings(undefined, buildEnv());
    expect(merged.notionPrDatabaseId).toBe("notion-database-id");
  });

  it("should use pr_summary_base_branches json when present", () => {
    const merged = mergeWorkspaceSettings(
      row({ prSummaryBaseBranches: ["main", "release"] }),
      buildEnv({ PR_SUMMARY_BASE_BRANCHES: "develop" }),
    );
    expect(merged.prSummaryBaseBranches).toEqual(["main", "release"]);
  });

  it("should fall back to env PR_SUMMARY_BASE_BRANCHES when json absent", () => {
    const merged = mergeWorkspaceSettings(undefined, buildEnv({ PR_SUMMARY_BASE_BRANCHES: "a, b" }));
    expect(merged.prSummaryBaseBranches).toEqual(["a", "b"]);
  });

  it("should merge RELEASE_EXPO_APP_CONFIG_PATH from env", () => {
    const merged = mergeWorkspaceSettings(undefined, buildEnv({ RELEASE_EXPO_APP_CONFIG_PATH: "app.json" }));
    expect(merged.releaseExpoAppConfigPath).toBe("app.json");
  });
});

describe("config/workspace-settings validateMergedWorkspaceSettings", () => {
  it("should throw when notion PR database id resolves empty", () => {
    const merged = mergeWorkspaceSettings(
      undefined,
      buildEnv({ NOTION_DATABASE_ID: undefined }),
    );
    expect(() => validateMergedWorkspaceSettings(merged)).toThrow(/Notion PR database id is missing/);
  });

  it("should throw when releases enabled without any version source", () => {
    const merged: Parameters<typeof validateMergedWorkspaceSettings>[0] = {
      notionPrDatabaseId: "pr-db",
      notionReleasesDatabaseId: "rel-db",
      prSummaryBaseBranches: null,
      releaseInfoPlistPath: null,
      releaseVersionBranch: "develop",
      releaseMonitoredRepo: null,
      releaseProjectPbxprojPath: null,
      releaseExpoAppConfigPath: null,
      releaseCompareRootSha: null,
    };
    expect(() => validateMergedWorkspaceSettings(merged)).toThrow(/no version source is configured/);
  });

  it("should throw when releases enabled without branch", () => {
    const merged: Parameters<typeof validateMergedWorkspaceSettings>[0] = {
      notionPrDatabaseId: "pr-db",
      notionReleasesDatabaseId: "rel-db",
      prSummaryBaseBranches: null,
      releaseInfoPlistPath: "Info.plist",
      releaseVersionBranch: null,
      releaseMonitoredRepo: null,
      releaseProjectPbxprojPath: null,
      releaseExpoAppConfigPath: null,
      releaseCompareRootSha: null,
    };
    expect(() => validateMergedWorkspaceSettings(merged)).toThrow(/release_version_branch/);
  });

  it("should accept releases with only Expo app config path", () => {
    const merged: Parameters<typeof validateMergedWorkspaceSettings>[0] = {
      notionPrDatabaseId: "pr-db",
      notionReleasesDatabaseId: "rel-db",
      prSummaryBaseBranches: null,
      releaseInfoPlistPath: null,
      releaseVersionBranch: "develop",
      releaseMonitoredRepo: null,
      releaseProjectPbxprojPath: null,
      releaseExpoAppConfigPath: "app.config.js",
      releaseCompareRootSha: null,
    };
    expect(() => validateMergedWorkspaceSettings(merged)).not.toThrow();
  });

  it("should accept valid merged settings with releases enabled", () => {
    const merged = mergeWorkspaceSettings(
      row({
        notionPrDatabaseId: "pr-from-db",
        notionReleasesDatabaseId: "rel",
        releaseInfoPlistPath: "ios/App/Info.plist",
        releaseVersionBranch: "develop",
        releaseExpoAppConfigPath: null,
      }),
      buildEnv({ NOTION_DATABASE_ID: undefined, NOTION_RELEASES_DATABASE_ID: undefined }),
    );
    expect(() => validateMergedWorkspaceSettings(merged)).not.toThrow();
  });
});

describe("config/workspace-settings execute", () => {
  it("should read the newest workspace_settings row from the database", async () => {
    const stored = row({
      notionPrDatabaseId: "from-pg",
      notionReleasesDatabaseId: null,
    });
    const limit = vi.fn(async () => [stored]);
    const orderBy = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ orderBy }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as never;

    const merged = await loadWorkspaceSettings(db, buildEnv({ NOTION_DATABASE_ID: "ignored" }));

    expect(merged.notionPrDatabaseId).toBe("from-pg");
    expect(select).toHaveBeenCalledOnce();
  });
});
