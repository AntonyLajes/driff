import { describe, expect, it, vi } from "vitest";

vi.mock("@/github/repo-kind-infer.js", () => ({ inferRepoKind: vi.fn() }));

import { inferRepoKind } from "@/github/repo-kind-infer.js";
import {
  inferAndApplyWorkspaceSettings,
  upsertInferredReleaseSettings,
} from "@/workspaces/infer-workspace-settings.js";

const expoInference = {
  suggestedKind: "react_native_expo",
  confidence: "high" as const,
  defaultBranch: "main",
  versionFilePath: "app.json",
  signals: ["dependency:expo"],
};

const buildDb = (selectRows: unknown[][] = []) => {
  const queue = [...selectRows];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => queue.shift() ?? []) })),
    })),
  }));
  const updateWhere = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  const values = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values }));
  return { db: { select, update, insert } as never, select, update, set, insert, values };
};

describe("workspaces/infer-workspace-settings apply", () => {
  it("reports a dry inference without writing release settings", async () => {
    vi.mocked(inferRepoKind).mockResolvedValue(expoInference);
    const db = buildDb();

    const result = await inferAndApplyWorkspaceSettings({
      db: db.db,
      octokit: {} as never,
      workspaceId: "workspace-id",
      repoFullName: "acme/app",
      workspaceDefaultBranch: "main",
      workspaceKind: "react_native_expo",
      apply: false,
    });

    expect(result).toEqual({
      inference: expoInference,
      applied: false,
      skipReason: "apply_disabled",
      settings: null,
      workspaceDefaultBranchUpdated: false,
      workspaceKindUpdated: false,
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("fills missing workspace metadata even when settings cannot be applied", async () => {
    const inference = { ...expoInference, versionFilePath: null };
    vi.mocked(inferRepoKind).mockResolvedValue(inference);
    const db = buildDb();

    const result = await inferAndApplyWorkspaceSettings({
      db: db.db,
      octokit: {} as never,
      workspaceId: "workspace-id",
      repoFullName: "acme/app",
      workspaceDefaultBranch: null,
      workspaceKind: null,
      apply: true,
    });

    expect(result).toMatchObject({
      applied: false,
      skipReason: "missing_version_file",
      workspaceDefaultBranchUpdated: true,
      workspaceKindUpdated: true,
    });
    expect(db.set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ repoDefaultBranch: "main" }),
    );
    expect(db.set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workspaceKind: "react_native_expo" }),
    );
  });

  it("updates an existing settings row with normalized legacy paths", async () => {
    vi.mocked(inferRepoKind).mockResolvedValue(expoInference);
    const db = buildDb([
      [{ id: "settings-id" }],
      [
        {
          releaseProjectKind: "react_native_expo",
          releaseVersionFilePath: "app.json",
          releaseVersionBranch: "main",
        },
      ],
    ]);

    const result = await inferAndApplyWorkspaceSettings({
      db: db.db,
      octokit: {} as never,
      workspaceId: "workspace-id",
      repoFullName: "acme/app",
      workspaceDefaultBranch: "main",
      workspaceKind: "react_native_expo",
      apply: true,
    });

    expect(result).toMatchObject({
      applied: true,
      skipReason: null,
      settings: {
        releaseProjectKind: "react_native_expo",
        releaseVersionFilePath: "app.json",
        releaseVersionBranch: "main",
      },
    });
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseProjectKind: "react_native_expo",
        releaseVersionFilePath: "app.json",
        releaseInfoPlistPath: null,
        releaseProjectPbxprojPath: null,
        releaseExpoAppConfigPath: "app.json",
      }),
    );
  });

  it("creates settings when the workspace has no row", async () => {
    const db = buildDb([
      [],
      [
        {
          releaseProjectKind: "ios_plist",
          releaseVersionFilePath: "ios/App/Info.plist",
          releaseVersionBranch: null,
        },
      ],
    ]);

    const settings = await upsertInferredReleaseSettings(db.db, "workspace-id", {
      releaseProjectKind: "ios_plist",
      releaseVersionFilePath: " ios/App/Info.plist ",
      releaseVersionBranch: null,
    });

    expect(settings.releaseProjectKind).toBe("ios_plist");
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-id",
        releaseVersionFilePath: "ios/App/Info.plist",
        releaseInfoPlistPath: "ios/App/Info.plist",
      }),
    );
  });

  it("fails loudly if an upsert cannot be read back", async () => {
    const db = buildDb([[], []]);

    await expect(
      upsertInferredReleaseSettings(db.db, "workspace-id", {
        releaseProjectKind: "ios_pbx",
        releaseVersionFilePath: "App.xcodeproj/project.pbxproj",
        releaseVersionBranch: "develop",
      }),
    ).rejects.toThrow("settings_row_missing_after_upsert");
  });
});
