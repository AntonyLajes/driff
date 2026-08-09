import { describe, expect, it, vi } from "vitest";

import {
  hasReleaseVersionSource,
  mergeWorkspaceSettingsRow,
  resolveWorkspaceSettingsForRepo,
} from "@/config/workspace-settings.js";
import type { workspaceSettingsTable } from "@/db/schema.js";

const row = (
  partial: Partial<typeof workspaceSettingsTable.$inferSelect>,
): typeof workspaceSettingsTable.$inferSelect =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: null,
    releaseInfoPlistPath: null,
    releaseVersionBranch: null,
    releaseMonitoredRepo: null,
    releaseProjectPbxprojPath: null,
    releaseExpoAppConfigPath: null,
    releaseProjectKind: null,
    releaseVersionFilePath: null,
    releaseCompareRootSha: null,
    prSummaryBaseBranches: null,
    pushSummaryBranches: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  }) as typeof workspaceSettingsTable.$inferSelect;

describe("config/workspace-settings mergeWorkspaceSettings", () => {
  it("should normalize a workspace row without env fallback", () => {
    const merged = mergeWorkspaceSettingsRow(
      row({
        releaseProjectKind: "react_native_expo",
        releaseVersionFilePath: "app.json",
      }),
    );
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
        row({ releaseProjectKind: "ios_plist", releaseVersionFilePath: null }),
      ),
    ).toThrow(/release_version_file_path/);
  });

  it("should throw for an unknown release_project_kind", () => {
    expect(() =>
      mergeWorkspaceSettingsRow(
        row({ releaseProjectKind: "future_unknown", releaseVersionFilePath: "VERSION" }),
      ),
    ).toThrow(/Invalid option/);
  });
});

describe("hasReleaseVersionSource", () => {
  it("is true when a kind + a version path are present", () => {
    const merged = mergeWorkspaceSettingsRow(
      row({ releaseProjectKind: "react_native_expo", releaseVersionFilePath: "app.json" }),
    );
    expect(hasReleaseVersionSource(merged)).toBe(true);
  });

  it("is false with no release source", () => {
    const merged = mergeWorkspaceSettingsRow(row({}));
    expect(hasReleaseVersionSource(merged)).toBe(false);
  });
});

describe("resolveWorkspaceSettingsForRepo", () => {
  it("should resolve workspace_settings for a matching (provider, repo_full_name)", async () => {
    const wsId = "ws-ride";
    const workspaceFrom = vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: wsId }]) })),
    }));
    const settingsFrom = vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => [row({ workspaceId: wsId, releaseVersionBranch: "main" })]),
      })),
    }));
    const select = vi
      .fn()
      .mockImplementationOnce(() => ({ from: workspaceFrom }))
      .mockImplementationOnce(() => ({ from: settingsFrom }));
    const db = { select } as never;

    const merged = await resolveWorkspaceSettingsForRepo(db, "github", "AntonyLajes/ride-pack");

    expect(merged).not.toBeNull();
    if (merged === null) {
      throw new Error("expected merged workspace settings");
    }
    expect(merged.workspaceId).toBe(wsId);
    expect(merged.releaseVersionBranch).toBe("main");
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("should resolve even when no workspace_settings row exists (defaults)", async () => {
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

    const merged = await resolveWorkspaceSettingsForRepo(db, "github", "acme/repo");
    expect(merged).not.toBeNull();
    expect(merged?.workspaceId).toBe(wsId);
    expect(merged?.releaseProjectKind).toBeNull();
  });

  it("should return null when no workspace is linked to repository", async () => {
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
      })),
    }));
    const db = { select } as never;
    await expect(resolveWorkspaceSettingsForRepo(db, "github", "acme/unknown")).resolves.toBeNull();
  });

  it("should scope the workspace lookup by provider", async () => {
    const capturedWhere = vi.fn(() => ({ limit: vi.fn(async () => []) }));
    const select = vi.fn().mockImplementationOnce(() => ({
      from: vi.fn(() => ({ where: capturedWhere })),
    }));
    const db = { select } as never;

    await expect(
      resolveWorkspaceSettingsForRepo(db, "gitlab", "acme/repo"),
    ).resolves.toBeNull();
    expect(capturedWhere).toHaveBeenCalledTimes(1);
  });
});
