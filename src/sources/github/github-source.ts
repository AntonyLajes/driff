import { Octokit } from "@octokit/rest";

import { execute as loadEnv } from "@/config/env.js";
import {
  getInstallationOctokit,
  type OctokitLike,
} from "@/sources/github/github-installation.js";
import type {
  PullRequestEvent,
  PullRequestEventFile,
  PullRequestParticipant,
  Source,
} from "@/sources/source.js";

const DEFAULT_DIFF_MAX_BYTES = 200 * 1024;

interface PullRequestResponse {
  title: string;
  body: string | null;
  user: { login: string } | null;
  merged_at: string | null;
  head: { sha: string };
  base: { ref: string };
  merged_by: { login: string; type?: string } | null;
}

interface PullRequestFileResponse {
  filename: string;
  additions: number;
  deletions: number;
}

interface PullRequestCommitResponse {
  author: { login: string; type?: string } | null;
  commit: {
    author: { name: string | null; email?: string | null } | null;
    message: string;
  };
}

interface PullRequestReviewResponse {
  user: { login: string; type?: string } | null;
  state: string;
}

export type { OctokitLike } from "@/sources/github/github-installation.js";

const mapPullRequestFiles = (
  files: PullRequestFileResponse[],
): PullRequestEventFile[] => {
  return files.map((file) => ({
    path: file.filename,
    additions: file.additions,
    deletions: file.deletions,
  }));
};

const isBotIdentity = (login: string, type?: string): boolean =>
  type?.toLowerCase() === "bot" || /\[bot\]$/i.test(login);

const githubParticipant = (
  login: string,
  role: PullRequestParticipant["role"],
  type?: string,
): PullRequestParticipant => ({
  externalIdentity: `github:${login.trim().toLowerCase()}`,
  displayName: login,
  role,
  sourceUrl: `https://github.com/${encodeURIComponent(login)}`,
  isBot: isBotIdentity(login, type),
});

const gitParticipant = (
  displayName: string,
  role: PullRequestParticipant["role"],
): PullRequestParticipant => ({
  externalIdentity: `git-name:${displayName.trim().toLowerCase()}`,
  displayName: displayName.trim(),
  role,
  sourceUrl: null,
  isBot: /\[bot\]$/i.test(displayName.trim()),
});

const coauthorsFrom = (message: string): PullRequestParticipant[] => {
  const participants: PullRequestParticipant[] = [];
  const trailer = /^co-authored-by:\s*(.+?)\s*<[^>]+>\s*$/gim;
  for (const match of message.matchAll(trailer)) {
    const displayName = match[1]?.trim() ?? "";
    if (displayName.length > 0) {
      participants.push(gitParticipant(displayName, "coauthor"));
    }
  }
  return participants;
};

const dedupeParticipants = (
  participants: PullRequestParticipant[],
): PullRequestParticipant[] => {
  const unique = new Map<string, PullRequestParticipant>();
  for (const participant of participants) {
    unique.set(
      `${participant.externalIdentity}:${participant.role}`,
      participant,
    );
  }
  return [...unique.values()];
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

const getAppCredentials = (
  input: ExecuteInput,
): { appId: string; privateKey: string } => {
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
      const {
        octokit: installationOctokit,
        owner,
        repo: repository,
      } = await getInstallationOctokit({
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
      const commits: PullRequestCommitResponse[] = [];
      const reviews: PullRequestReviewResponse[] = [];
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

      page = 1;
      while (true) {
        const response = await installationOctokit.request<
          PullRequestCommitResponse[]
        >("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
          owner,
          repo: repository,
          pull_number: prNumber,
          per_page: 100,
          page,
        });
        const entries = response.data;
        commits.push(...entries);
        if (entries.length < 100) break;
        page += 1;
      }

      page = 1;
      while (true) {
        const response = await installationOctokit.request<
          PullRequestReviewResponse[]
        >("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
          owner,
          repo: repository,
          pull_number: prNumber,
          per_page: 100,
          page,
        });
        const entries = response.data;
        reviews.push(...entries);
        if (entries.length < 100) break;
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
      const participants = dedupeParticipants([
        ...commits.flatMap((commit) => {
          const author = commit.author;
          const commitAuthor =
            author !== null
              ? githubParticipant(author.login, "commit_author", author.type)
              : commit.commit.author?.name?.trim()
                ? gitParticipant(commit.commit.author.name, "commit_author")
                : null;
          return [
            ...(commitAuthor === null ? [] : [commitAuthor]),
            ...coauthorsFrom(commit.commit.message),
          ];
        }),
        ...reviews.flatMap((review) =>
          review.user === null || review.state.toUpperCase() === "PENDING"
            ? []
            : [
                githubParticipant(
                  review.user.login,
                  "reviewer",
                  review.user.type,
                ),
              ],
        ),
        ...(prData.merged_by == null
          ? []
          : [
              githubParticipant(
                prData.merged_by.login,
                "merger",
                prData.merged_by.type,
              ),
            ]),
      ]);

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
        participants,
      };
    },
  };
};
