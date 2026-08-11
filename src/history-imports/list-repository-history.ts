import { z } from "zod";

import {
  getInstallationOctokit,
  type OctokitLike,
} from "@/sources/github/github-installation.js";
import type { ReleaseVersionStrategy } from "@/config/release-version-strategy.js";
import { isSemverTag } from "@/lib/semver-tag.js";

const repositorySchema = z.object({ default_branch: z.string().min(1) });
const commitSchema = z.object({
  sha: z.string().min(1),
  parents: z.array(z.object({ sha: z.string().min(1) })),
  author: z
    .object({ login: z.string().min(1) })
    .nullable()
    .optional(),
  commit: z.object({
    author: z
      .object({ name: z.string().nullable(), date: z.string().nullable() })
      .nullable(),
    committer: z.object({ date: z.string().nullable() }).nullable(),
  }),
});
const commitsSchema = z.array(commitSchema);
const tagsSchema = z.array(
  z.object({
    name: z.string().min(1),
    commit: z.object({ sha: z.string().min(1) }),
  }),
);
const releasesSchema = z.array(
  z.object({
    tag_name: z.string().min(1),
    html_url: z.string().url(),
    draft: z.boolean(),
    published_at: z.string().nullable(),
    created_at: z.string(),
  }),
);

export interface RepositoryCommitReference {
  sourceKey: string;
  sha: string;
  beforeSha: string;
  committedAt: Date;
  pusher: string | null;
}

export interface RepositoryReleaseReference {
  sourceKey: string;
  tagName: string;
  beforeSha: string;
  afterSha: string;
  releasedAt: Date;
  sourceUrl?: string | null;
}

export interface ListRepositoryHistoryResult {
  defaultBranch: string;
  commits: RepositoryCommitReference[];
  releases: RepositoryReleaseReference[];
  truncated: boolean;
}

export interface ExecuteInput {
  appId: string;
  privateKey: string;
  octokitFactory?: (auth: string) => OctokitLike;
  pageSize?: number;
}

export interface ListRepositoryHistoryInput {
  repo: string;
  since: Date;
  maxItems: number;
  versionStrategy?: ReleaseVersionStrategy;
}

const commitDate = (commit: z.infer<typeof commitSchema>): Date | null => {
  const raw = commit.commit.committer?.date ?? commit.commit.author?.date;
  if (raw === null || raw === undefined) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const execute = (input: ExecuteInput) => ({
  list: async (
    request: ListRepositoryHistoryInput,
  ): Promise<ListRepositoryHistoryResult> => {
    const { octokit, owner, repo } = await getInstallationOctokit({
      appId: input.appId,
      privateKey: input.privateKey,
      repo: request.repo,
      octokitFactory: input.octokitFactory,
    });
    const repositoryResponse = await octokit.request<unknown>(
      "GET /repos/{owner}/{repo}",
      { owner, repo },
    );
    const repository = repositorySchema.safeParse(repositoryResponse.data);
    if (!repository.success) {
      throw new Error("GitHub returned invalid repository metadata.", {
        cause: repository.error,
      });
    }

    const pageSize = Math.min(input.pageSize ?? 100, 100);
    const commits: RepositoryCommitReference[] = [];
    let commitPage = 1;
    let truncated = false;
    while (commits.length < request.maxItems) {
      const response = await octokit.request<unknown>(
        "GET /repos/{owner}/{repo}/commits",
        {
          owner,
          repo,
          sha: repository.data.default_branch,
          since: request.since.toISOString(),
          per_page: pageSize,
          page: commitPage,
        },
      );
      const parsed = commitsSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error("GitHub returned an invalid commit history response.", {
          cause: parsed.error,
        });
      }
      if (parsed.data.length === 0) break;

      for (const commit of parsed.data) {
        const committedAt = commitDate(commit);
        const beforeSha = commit.parents[0]?.sha;
        if (
          committedAt === null ||
          committedAt < request.since ||
          beforeSha === undefined
        ) {
          continue;
        }
        if (commits.length === request.maxItems) {
          truncated = true;
          break;
        }
        commits.push({
          sourceKey: `commit:${commit.sha}`,
          sha: commit.sha,
          beforeSha,
          committedAt,
          pusher: commit.author?.login ?? commit.commit.author?.name ?? null,
        });
      }
      if (truncated || parsed.data.length < pageSize) break;
      commitPage += 1;
    }

    const strategy = request.versionStrategy ?? "version_file";
    const tagLimit = Math.min(request.maxItems + 1, 100);
    let releaseCandidates: Array<{
      name: string;
      sourceUrl: string | null;
      releasedAt: Date | null;
    }>;
    let rawCandidateCount: number;
    if (strategy === "github_release") {
      const response = await octokit.request<unknown>(
        "GET /repos/{owner}/{repo}/releases",
        { owner, repo, per_page: tagLimit, page: 1 },
      );
      const parsed = releasesSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error("GitHub returned an invalid release history response.", {
          cause: parsed.error,
        });
      }
      rawCandidateCount = parsed.data.length;
      releaseCandidates = parsed.data
        .filter((release) => !release.draft && isSemverTag(release.tag_name))
        .map((release) => {
          const date = new Date(release.published_at ?? release.created_at);
          return {
            name: release.tag_name,
            sourceUrl: release.html_url,
            releasedAt: Number.isNaN(date.getTime()) ? null : date,
          };
        });
    } else {
      const response = await octokit.request<unknown>(
        "GET /repos/{owner}/{repo}/tags",
        { owner, repo, per_page: tagLimit, page: 1 },
      );
      const parsed = tagsSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error("GitHub returned an invalid tag history response.", {
          cause: parsed.error,
        });
      }
      rawCandidateCount = parsed.data.length;
      releaseCandidates = parsed.data
        .filter((tag) => strategy === "version_file" || isSemverTag(tag.name))
        .map((tag) => ({
          name: tag.name,
          sourceUrl: null,
          releasedAt: null,
        }));
    }

    const resolvedTags: Array<{
      name: string;
      sha: string;
      parentSha: string | null;
      committedAt: Date;
      sourceUrl: string | null;
    }> = [];
    for (const candidate of releaseCandidates) {
      const response = await octokit.request<unknown>(
        "GET /repos/{owner}/{repo}/commits/{ref}",
        { owner, repo, ref: candidate.name },
      );
      const parsed = commitSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error(
          `GitHub returned invalid metadata for tag "${candidate.name}".`,
          {
            cause: parsed.error,
          },
        );
      }
      const committedAt = candidate.releasedAt ?? commitDate(parsed.data);
      if (committedAt === null) continue;
      resolvedTags.push({
        name: candidate.name,
        sha: parsed.data.sha,
        parentSha: parsed.data.parents[0]?.sha ?? null,
        committedAt,
        sourceUrl: candidate.sourceUrl,
      });
    }
    resolvedTags.sort(
      (left, right) => left.committedAt.getTime() - right.committedAt.getTime(),
    );

    const releases: RepositoryReleaseReference[] = [];
    for (const [index, tag] of resolvedTags.entries()) {
      if (tag.committedAt < request.since) continue;
      if (releases.length === request.maxItems) {
        truncated = true;
        break;
      }
      const beforeSha = resolvedTags[index - 1]?.sha ?? tag.parentSha;
      if (beforeSha === null || beforeSha === tag.sha) continue;
      releases.push({
        sourceKey: `release:${tag.name}:${tag.sha}`,
        tagName: tag.name,
        beforeSha,
        afterSha: tag.sha,
        releasedAt: tag.committedAt,
        sourceUrl: tag.sourceUrl,
      });
    }

    if (rawCandidateCount === tagLimit) truncated = true;
    return {
      defaultBranch: repository.data.default_branch,
      commits: commits.sort(
        (left, right) =>
          left.committedAt.getTime() - right.committedAt.getTime(),
      ),
      releases,
      truncated,
    };
  },
});
