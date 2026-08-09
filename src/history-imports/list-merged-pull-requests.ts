import { z } from "zod";

import {
  getInstallationOctokit,
  type OctokitLike,
} from "@/sources/github/github-installation.js";

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  merged_at: z.string().datetime({ offset: true }).nullable(),
  updated_at: z.string().datetime({ offset: true }),
});

const pullRequestsSchema = z.array(pullRequestSchema);

export interface MergedPullRequestReference {
  prNumber: number;
  mergedAt: Date;
}

export interface ListMergedPullRequestsResult {
  pullRequests: MergedPullRequestReference[];
  truncated: boolean;
}

export interface ExecuteInput {
  appId: string;
  privateKey: string;
  octokitFactory?: (auth: string) => OctokitLike;
  pageSize?: number;
}

export interface ListMergedPullRequestsInput {
  repo: string;
  since: Date;
  maxPullRequests: number;
}

export const execute = (input: ExecuteInput) => ({
  list: async (
    request: ListMergedPullRequestsInput,
  ): Promise<ListMergedPullRequestsResult> => {
    const { octokit, owner, repo } = await getInstallationOctokit({
      appId: input.appId,
      privateKey: input.privateKey,
      repo: request.repo,
      octokitFactory: input.octokitFactory,
    });
    const pageSize = Math.min(input.pageSize ?? 100, 100);
    const pullRequests: MergedPullRequestReference[] = [];
    let page = 1;
    let truncated = false;

    while (pullRequests.length < request.maxPullRequests) {
      const response = await octokit.request<unknown>(
        "GET /repos/{owner}/{repo}/pulls",
        {
          owner,
          repo,
          state: "closed",
          sort: "updated",
          direction: "desc",
          per_page: pageSize,
          page,
        },
      );
      const parsed = pullRequestsSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error(
          "GitHub returned an invalid pull request history response.",
          {
            cause: parsed.error,
          },
        );
      }
      if (parsed.data.length === 0) {
        break;
      }

      let pageHasRecentUpdates = false;
      for (const pullRequest of parsed.data) {
        const updatedAt = new Date(pullRequest.updated_at);
        if (updatedAt >= request.since) {
          pageHasRecentUpdates = true;
        }
        if (pullRequest.merged_at === null) {
          continue;
        }
        const mergedAt = new Date(pullRequest.merged_at);
        if (mergedAt < request.since) {
          continue;
        }
        if (pullRequests.length === request.maxPullRequests) {
          truncated = true;
          break;
        }
        pullRequests.push({ prNumber: pullRequest.number, mergedAt });
      }

      if (truncated || parsed.data.length < pageSize || !pageHasRecentUpdates) {
        break;
      }
      page += 1;
    }

    return {
      pullRequests: pullRequests.sort(
        (left, right) => left.mergedAt.getTime() - right.mergedAt.getTime(),
      ),
      truncated,
    };
  },
});
