import type { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";

import {
  applyReleaseKindAndFilePath,
  isSupportedReleaseProjectKind,
  parseReleaseProjectKind,
  type ReleaseProjectKind,
} from "@/config/release-project-kind.js";
import type { Database } from "@/db/client.js";
import { workspaceSettingsTable, workspacesTable } from "@/db/schema.js";
import type { RepoKindInference } from "@/github/repo-kind-infer.js";
import { inferRepoKind } from "@/github/repo-kind-infer.js";

export type WorkspaceSettingsPublic = {
  releaseProjectKind: string | null;
  releaseVersionFilePath: string | null;
  releaseVersionBranch: string | null;
};

export type InferWorkspaceSettingsSkipReason =
  | "unsupported_release_kind"
  | "missing_version_file"
  | "missing_suggested_kind"
  | "apply_disabled";

export type InferWorkspaceSettingsResult = {
  inference: RepoKindInference;
  applied: boolean;
  skipReason: InferWorkspaceSettingsSkipReason | null;
  settings: WorkspaceSettingsPublic | null;
  workspaceDefaultBranchUpdated: boolean;
  workspaceKindUpdated: boolean;
};

const nonBlankOrNull = (s: string | null): string | null => {
  const t = s?.trim();
  return t && t.length > 0 ? t : null;
};

export const mapInferenceToReleasePatch = (
  inference: RepoKindInference,
): {
  canApply: boolean;
  skipReason: InferWorkspaceSettingsSkipReason | null;
  releaseProjectKind: ReleaseProjectKind | null;
  releaseVersionFilePath: string | null;
  releaseVersionBranch: string | null;
} => {
  const kindRaw = inference.suggestedKind?.trim() ?? "";
  const path = inference.versionFilePath?.trim() ?? "";
  const branch = inference.defaultBranch?.trim() ?? "";

  if (kindRaw.length === 0) {
    return {
      canApply: false,
      skipReason: "missing_suggested_kind",
      releaseProjectKind: null,
      releaseVersionFilePath: null,
      releaseVersionBranch: branch.length > 0 ? branch : null,
    };
  }

  let kind: ReleaseProjectKind;
  try {
    kind = parseReleaseProjectKind(kindRaw);
  } catch {
    return {
      canApply: false,
      skipReason: "unsupported_release_kind",
      releaseProjectKind: null,
      releaseVersionFilePath: null,
      releaseVersionBranch: branch.length > 0 ? branch : null,
    };
  }

  if (!isSupportedReleaseProjectKind(kind)) {
    return {
      canApply: false,
      skipReason: "unsupported_release_kind",
      releaseProjectKind: null,
      releaseVersionFilePath: null,
      releaseVersionBranch: branch.length > 0 ? branch : null,
    };
  }

  if (path.length === 0) {
    return {
      canApply: false,
      skipReason: "missing_version_file",
      releaseProjectKind: kind,
      releaseVersionFilePath: null,
      releaseVersionBranch: branch.length > 0 ? branch : null,
    };
  }

  return {
    canApply: true,
    skipReason: null,
    releaseProjectKind: kind,
    releaseVersionFilePath: path,
    releaseVersionBranch: branch.length > 0 ? branch : null,
  };
};

const readSettingsPublic = (
  row:
    | {
        releaseProjectKind: string | null;
        releaseVersionFilePath: string | null;
        releaseVersionBranch: string | null;
      }
    | undefined,
): WorkspaceSettingsPublic | null => {
  if (row === undefined) {
    return null;
  }
  return {
    releaseProjectKind: row.releaseProjectKind ?? null,
    releaseVersionFilePath: row.releaseVersionFilePath ?? null,
    releaseVersionBranch: row.releaseVersionBranch ?? null,
  };
};

export const upsertInferredReleaseSettings = async (
  db: Database,
  workspaceId: string,
  patch: {
    releaseProjectKind: ReleaseProjectKind;
    releaseVersionFilePath: string;
    releaseVersionBranch: string | null;
  },
): Promise<WorkspaceSettingsPublic> => {
  const now = new Date();
  const applied = applyReleaseKindAndFilePath(patch.releaseProjectKind, patch.releaseVersionFilePath);

  const releasePatch = {
    releaseProjectKind: patch.releaseProjectKind,
    releaseVersionFilePath: patch.releaseVersionFilePath.trim(),
    releaseInfoPlistPath: nonBlankOrNull(applied.releaseInfoPlistPath),
    releaseProjectPbxprojPath: nonBlankOrNull(applied.releaseProjectPbxprojPath),
    releaseExpoAppConfigPath: nonBlankOrNull(applied.releaseExpoAppConfigPath),
    releaseVersionBranch: patch.releaseVersionBranch,
    updatedAt: now,
  };

  const existing = await db
    .select({ id: workspaceSettingsTable.id })
    .from(workspaceSettingsTable)
    .where(eq(workspaceSettingsTable.workspaceId, workspaceId))
    .limit(1);
  const existingRow = existing[0];

  if (existingRow !== undefined) {
    await db
      .update(workspaceSettingsTable)
      .set(releasePatch)
      .where(eq(workspaceSettingsTable.id, existingRow.id));
  } else {
    await db.insert(workspaceSettingsTable).values({
      workspaceId,
      ...releasePatch,
      createdAt: now,
    });
  }

  const rows = await db
    .select({
      releaseProjectKind: workspaceSettingsTable.releaseProjectKind,
      releaseVersionFilePath: workspaceSettingsTable.releaseVersionFilePath,
      releaseVersionBranch: workspaceSettingsTable.releaseVersionBranch,
    })
    .from(workspaceSettingsTable)
    .where(eq(workspaceSettingsTable.workspaceId, workspaceId))
    .limit(1);

  const settings = readSettingsPublic(rows[0]);
  if (settings === null) {
    throw new Error("settings_row_missing_after_upsert");
  }
  return settings;
};

export const inferAndApplyWorkspaceSettings = async (input: {
  db: Database;
  octokit: Octokit;
  workspaceId: string;
  repoFullName: string;
  workspaceDefaultBranch: string | null;
  workspaceKind: string | null;
  apply: boolean;
}): Promise<InferWorkspaceSettingsResult> => {
  const inference = await inferRepoKind(input.octokit, input.repoFullName);
  const mapped = mapInferenceToReleasePatch(inference);

  let workspaceDefaultBranchUpdated = false;
  let workspaceKindUpdated = false;

  const defaultBranch = inference.defaultBranch?.trim() ?? "";
  if (defaultBranch.length > 0) {
    const current = input.workspaceDefaultBranch?.trim() ?? "";
    if (current.length === 0) {
      await input.db
        .update(workspacesTable)
        .set({ repoDefaultBranch: defaultBranch, updatedAt: new Date() })
        .where(eq(workspacesTable.id, input.workspaceId));
      workspaceDefaultBranchUpdated = true;
    }
  }

  if (
    mapped.releaseProjectKind !== null &&
    isSupportedReleaseProjectKind(mapped.releaseProjectKind) &&
    (input.workspaceKind === null || input.workspaceKind.trim().length === 0)
  ) {
    await input.db
      .update(workspacesTable)
      .set({ workspaceKind: mapped.releaseProjectKind, updatedAt: new Date() })
      .where(eq(workspacesTable.id, input.workspaceId));
    workspaceKindUpdated = true;
  }

  if (!input.apply) {
    return {
      inference,
      applied: false,
      skipReason: "apply_disabled",
      settings: null,
      workspaceDefaultBranchUpdated,
      workspaceKindUpdated,
    };
  }

  if (!mapped.canApply || mapped.releaseProjectKind === null || mapped.releaseVersionFilePath === null) {
    return {
      inference,
      applied: false,
      skipReason: mapped.skipReason,
      settings: null,
      workspaceDefaultBranchUpdated,
      workspaceKindUpdated,
    };
  }

  const settings = await upsertInferredReleaseSettings(input.db, input.workspaceId, {
    releaseProjectKind: mapped.releaseProjectKind,
    releaseVersionFilePath: mapped.releaseVersionFilePath,
    releaseVersionBranch: mapped.releaseVersionBranch,
  });

  return {
    inference,
    applied: true,
    skipReason: null,
    settings,
    workspaceDefaultBranchUpdated,
    workspaceKindUpdated,
  };
};
