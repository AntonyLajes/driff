import { Octokit } from "@octokit/rest";

import { execute as loadEnv } from "@/config/env.js";
import {
  getInstallationOctokit,
  type OctokitLike,
} from "@/sources/github/github-installation.js";
import type { PullRequestEvent, PullRequestEventFile, Source } from "@/sources/source.js";

const DEFAULT_DIFF_MAX_BYTES = 200 * 1024;

interface PullRequestResponse {
  title: string;
  body: string | null;
  user: { login: string } | null;
  merged_at: string | null;
  head: { sha: string };
  base: { ref: string };
}

interface PullRequestFileResponse {
  filename: string;
  additions: number;
  deletions: number;
}

export type { OctokitLike } from "@/sources/github/github-installation.js";

const mapPullRequestFiles = (files: PullRequestFileResponse[]): PullRequestEventFile[] => {
  return files.map((file) => ({
    path: file.filename,
    additions: file.additions,
    deletions: file.deletions,
  }));
};

const truncateDiff = (diff: string, maxBytes: number): string => {
  const size = Buffer.byteLength(diff, "utf8");
  if (size <= maxBytes) {
    return diff;
  }

  const diffBuffer = Buffer.from(diff, "utf8");
  const truncated = diffBuffer.subarray(0, maxBytes).toString("utf8");
  return `${truncated}\n\n[diff truncated to ${maxBytes} bytes]`;
};

const getOctokitFactory = (
  octokitFactory?: ExecuteInput["octokitFactory"],
): ((auth: string) => OctokitLike) => {
  if (octokitFactory) {
    return octokitFactory;
  }

  return (auth) => new Octokit({ auth }) as unknown as OctokitLike;
};

export interface ExecuteInput {
  appId?: string;
  privateKey?: string;
  diffMaxBytes?: number;
  octokitFactory?: (auth: string) => OctokitLike;
}

const getAppCredentials = (input: ExecuteInput): { appId: string; privateKey: string } => {
  if (input.appId && input.privateKey) {
    return { appId: input.appId, privateKey: input.privateKey };
  }

  const env = loadEnv();
  return {
    appId: input.appId ?? env.GITHUB_APP_ID,
    privateKey: input.privateKey ?? env.GITHUB_APP_PRIVATE_KEY,
  };
};

export const execute = (input: ExecuteInput = {}): Source => {
  const { appId, privateKey } = getAppCredentials(input);
  const octokitFactory = getOctokitFactory(input.octokitFactory);
  const diffMaxBytes = input.diffMaxBytes ?? DEFAULT_DIFF_MAX_BYTES;

  return {
    fetchPullRequest: async (repo, prNumber): Promise<PullRequestEvent> => {
      const { octokit: installationOctokit, owner, repo: repository } =
        await getInstallationOctokit({
          appId,
          privateKey,
          repo,
          octokitFactory,
        });

      const prResponse = await installationOctokit.pulls.get({
        owner,
        repo: repository,
        pull_number: prNumber,
      });
      const prData = prResponse.data as PullRequestResponse;

      const files: PullRequestFileResponse[] = [];
      let page = 1;

      while (true) {
        const filesResponse = await installationOctokit.pulls.listFiles({
          owner,
          repo: repository,
          pull_number: prNumber,
          per_page: 100,
          page,
        });

        files.push(...(filesResponse.data as PullRequestFileResponse[]));
        if ((filesResponse.data as PullRequestFileResponse[]).length < 100) {
          break;
        }
        page += 1;
      }

      const diffResponse = await installationOctokit.request<string>(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner,
          repo: repository,
          pull_number: prNumber,
          headers: {
            accept: "application/vnd.github.v3.diff",
          },
        },
      );

      if (!prData.merged_at) {
        throw new Error(`Pull request ${repo}#${prNumber} is not merged.`);
      }

      return {
        repo,
        prNumber,
        title: prData.title,
        body: prData.body,
        author: prData.user?.login ?? "unknown",
        mergedAt: new Date(prData.merged_at),
        headSha: prData.head.sha,
        baseBranch: prData.base.ref,
        diff: truncateDiff(diffResponse.data, diffMaxBytes),
        files: mapPullRequestFiles(files),
      };
    },
  };
};
