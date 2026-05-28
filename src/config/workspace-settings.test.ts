import { describe, expect, it, vi } from "vitest";

import {
  mergeWorkspaceSettingsRow,
  resolveWorkspaceSettingsForRepo,
  validateMergedWorkspaceSettings,
} from "@/config/workspace-settings.js";
import type { workspaceSettingsTable } from "@/db/schema.js";

const row = (
  partial: Partial<typeof workspaceSettingsTable.$inferSelect>,
): typeof workspaceSettingsTable.$inferSelect =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: null,
    notionPrDatabaseId: null,
    notionReleasesDatabaseId: null,
    releaseInfoPlistPath: null,
    releaseVersionBranch: null,
    releaseMonitoredRepo: null,
    releaseProjectPbxprojPath: null,
    releaseExpoAppConfigPath: null,
    releaseProjectKind: null,
    releaseVersionFilePath: null,
    releaseCompareRootSha: null,
    prSummaryBaseBranches: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  }) as typeof workspaceSettingsTable.$inferSelect;

describe("config/workspace-settings mergeWorkspaceSettings", () => {
  it("should normalize a workspace row without env fallback", () => {
    const merged = mergeWorkspaceSettingsRow(
      row({
        notionPrDatabaseId: "from-db",
        releaseProjectKind: "react_native_expo",
        releaseVersionFilePath: "app.json",
      }),
    );
    expect(merged.notionPrDatabaseId).toBe("from-db");
    expect(merged.releaseProjectKind).toBe("react_native_expo");
    expect(merged.releaseVersionFilePath).toBe("app.json");
  });

  it("should prefer DB unified columns over legacy columns", () => {
    const merged = mergeWorkspaceSettingsRow(
      row({
        releaseProjectKind: "ios_plist",
        releaseVersionFilePath: "App/Info.plist",
        releaseInfoPlistPath: "wrong/Info.plist",
        releaseExpoAppConfigPath: "app.json",
      }),
    );
    expect(merged.releaseInfoPlistPath).toBe("App/Info.plist");
    expect(merged.releaseExpoAppConfigPath).toBeNull();
    expect(merged.releaseProjectKind).toBe("ios_plist");
    expect(merged.releaseVersionFilePath).toBe("App/Info.plist");
  });

  it("should throw when only RELEASE_PROJECT_KIND is set without path", () => {
    expect(() =>
      mergeWorkspaceSettingsRow(
        row({
          releaseProjectKind: "ios_plist",
          releaseVersionFilePath: null,
        }),
      ),
    ).toThrow(/release_version_file_path/);
  });

  it("should throw for unsupported release_project_kind", () => {
    expect(() =>
      mergeWorkspaceSettingsRow(
        row({ releaseProjectKind: "android_gradle", releaseVersionFilePath: "app/build.gradle" }),
      ),
    ).toThrow(/not supported yet/);
  });
});

describe("config/workspace-settings validateMergedWorkspaceSettings", () => {
  it("should throw when notion PR database id is missing", () => {
    const merged = mergeWorkspaceSettingsRow(row({ notionPrDatabaseId: null }));
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
      releaseProjectKind: null,
      releaseVersionFilePath: null,
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
      releaseProjectKind: null,
      releaseVersionFilePath: null,
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
      releaseProjectKind: "react_native_expo",
      releaseVersionFilePath: "app.config.js",
    };
    expect(() => validateMergedWorkspaceSettings(merged)).not.toThrow();
  });

  it("should accept valid merged settings with releases enabled", () => {
    const merged = mergeWorkspaceSettingsRow(
      row({
        notionPrDatabaseId: "pr-from-db",
        notionReleasesDatabaseId: "rel",
        releaseInfoPlistPath: "ios/App/Info.plist",
        releaseVersionBranch: "develop",
        releaseExpoAppConfigPath: null,
      }),
    );
    expect(() => validateMergedWorkspaceSettings(merged)).not.toThrow();
  });
});

describe("resolveWorkspaceSettingsForRepo", () => {
  it("should prefer workspace_settings for a matching github_repo_full_name", async () => {
    const wsId = "ws-ride";
    const workspaceFrom = vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: wsId }]) })),
    }));
    const settingsFrom = vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => [
          row({
            workspaceId: wsId,
            releaseVersionBranch: "main",
            notionPrDatabaseId: "pr-ws",
          }),
        ]),
      })),
    }));
    const select = vi
      .fn()
      .mockImplementationOnce(() => ({ from: workspaceFrom }))
      .mockImplementationOnce(() => ({ from: settingsFrom }));
    const db = { select } as never;

    const merged = await resolveWorkspaceSettingsForRepo(db, "AntonyLajes/ride-pack");

    expect(merged).not.toBeNull();
    if (merged === null) {
      throw new Error("expected merged workspace settings");
    }
    expect(merged.releaseVersionBranch).toBe("main");
    expect(merged.notionPrDatabaseId).toBe("pr-ws");
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("should return null when no workspace is linked to repository", async () => {
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
      })),
    }));
    const db = { select } as never;
    await expect(resolveWorkspaceSettingsForRepo(db, "acme/unknown")).resolves.toBeNull();
  });

  it("should return null when workspace exists but settings row is missing", async () => {
    const wsId = "ws-no-settings";
    const select = vi
      .fn()
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: wsId }]) })),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
      }));
    const db = { select } as never;
    await expect(resolveWorkspaceSettingsForRepo(db, "acme/repo")).resolves.toBeNull();
  });
});
