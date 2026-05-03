import { z } from "zod";

import type { ProcessReleaseJobInput } from "@/http/routes/webhooks-dependencies.js";

const nullSha = (sha: string): boolean => /^0+$/.test(sha);

const pushPayloadSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  repository: z.object({ full_name: z.string() }),
  commits: z
    .array(
      z.object({
        added: z.array(z.string()).optional(),
        modified: z.array(z.string()).optional(),
        removed: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

export const refToBranch = (ref: string): string | null => {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) {
    return null;
  }
  return ref.slice(prefix.length) || null;
};

const commitTouchesFilePath = (
  payload: {
    commits?: Array<{
      added?: string[];
      modified?: string[];
      removed?: string[];
    }>;
  },
  filePath: string,
): boolean => {
  const commits = payload.commits;
  if (!commits || commits.length === 0) {
    return true;
  }
  if (commits.length >= 20) {
    return true;
  }
  for (const commit of commits) {
    const allLists = [commit.added, commit.modified, commit.removed] as const;
    for (const list of allLists) {
      if (!list) {
        continue;
      }
      for (const path of list) {
        if (path === filePath) {
          return true;
        }
      }
    }
  }
  return false;
};

/** @deprecated use pushTouchesReleasePaths */
export const pushTouchesPlistPath = (
  payload: Parameters<typeof commitTouchesFilePath>[0],
  plistPath: string,
): boolean => {
  return commitTouchesFilePath(payload, plistPath);
};

/**
 * Verifica se algum commit do payload tocou um dos ficheiros onde a versão é alterada.
 * `versionWatchPaths` vem de `collectVersionWatchPaths` (um ou mais paths após resolver tipo + ficheiro).
 */
export const pushTouchesReleasePaths = (
  payload: {
    commits?: Array<{
      added?: string[];
      modified?: string[];
      removed?: string[];
    }>;
  },
  versionWatchPaths: readonly string[],
): boolean => {
  const paths = versionWatchPaths.map((p) => p.trim()).filter((p) => p.length > 0);
  if (paths.length === 0) {
    return true;
  }
  for (const path of paths) {
    if (commitTouchesFilePath(payload, path)) {
      return true;
    }
  }
  return false;
};

export interface ReleaseWebhookConfig {
  branch: string;
  /** Repo-relative paths that should trigger `process_release` when changed on the release branch. */
  versionWatchPaths: string[];
  monitoredRepo: string | null;
}

export const buildProcessReleaseJobInput = (
  eventType: string,
  payload: Record<string, unknown>,
  config: ReleaseWebhookConfig | null | undefined,
): ProcessReleaseJobInput | null => {
  if (config === null || config === undefined) {
    return null;
  }
  if (eventType !== "push") {
    return null;
  }

  const parsed = pushPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  if (nullSha(data.after) || nullSha(data.before)) {
    return null;
  }
  if (data.before === data.after) {
    return null;
  }

  const repo = data.repository.full_name;
  if (config.monitoredRepo && config.monitoredRepo !== repo) {
    return null;
  }

  const branch = refToBranch(data.ref);
  if (branch === null || branch !== config.branch) {
    return null;
  }

  if (!pushTouchesReleasePaths(data, config.versionWatchPaths)) {
    return null;
  }

  return {
    repo,
    beforeSha: data.before,
    afterSha: data.after,
    branch,
  };
};
