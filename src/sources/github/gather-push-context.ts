import { Octokit } from "@octokit/rest";

import { execute as loadEnv } from "@/config/env.js";
import {
  getInstallationOctokit,
  type OctokitLike,
} from "@/sources/github/github-installation.js";
import {
  extractPrNumbersFromCommitMessages,
  type GitHubCompareData,
} from "@/sources/github/gather-release-context.js";

const DEFAULT_DIFF_MAX_BYTES = 200 * 1024;

const nullSha = (sha: string): boolean => /^0+$/.test(sha);

export interface PushCommitEntry {
  sha: string;
  message: string;
}

export interface PushContext {
  /** Commits included in the GitHub compare range (API order). */
  compareCommits: PushCommitEntry[];
  commitMessages: string[];
  /** PR numbers referenced by commit messages (merge/squash), if any. */
  prNumbers: number[];
  totalCommits: number;
  compareUrl: string;
  fileChangeSummary: string;
  /** Diff stats aggregated from the compare files (null when unavailable). */
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  /** Truncated unified diff for the compare range. */
  diff: string;
}

export interface ExecuteInput {
  appId?: string;
  privateKey?: string;
  repo: string;
  beforeSha: string;
  afterSha: string;
  diffMaxBytes?: number;
  octokitFactory?: (auth: string) => OctokitLike;
}

const getCredentials = (input: ExecuteInput): { appId: string; privateKey: string } => {
  if (input.appId && input.privateKey) {
    return { appId: input.appId, privateKey: input.privateKey };
  }
  const env = loadEnv();
  return {
    appId: input.appId ?? env.GITHUB_APP_ID,
    privateKey: input.privateKey ?? env.GITHUB_APP_PRIVATE_KEY,
  };
};

const getOctokitFactory = (
  factory?: (auth: string) => OctokitLike,
): ((auth: string) => OctokitLike) => {
  if (factory) {
    return factory;
  }
  return (auth) => new Octokit({ auth }) as unknown as OctokitLike;
};

const buildFileChangeSummary = (
  files: Array<{ filename: string; status: string }> | undefined,
): string => {
  if (!files || files.length === 0) {
    return "Nenhum arquivo listado no compare (ou alterações apenas em binário).";
  }
  const lines = files.slice(0, 50).map((f) => `${f.status}: ${f.filename}`);
  if (files.length > 50) {
    lines.push(`… e mais ${files.length - 50} arquivos.`);
  }
  return lines.join("\n");
};

const truncateDiff = (diff: string, maxBytes: number): string => {
  const size = Buffer.byteLength(diff, "utf8");
  if (size <= maxBytes) {
    return diff;
  }
  const truncated = Buffer.from(diff, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${truncated}\n\n[diff truncated to ${maxBytes} bytes]`;
};

export const execute = async (input: ExecuteInput): Promise<PushContext> => {
  const beforeSha = input.beforeSha.trim();
  const afterSha = input.afterSha.trim();
  if (nullSha(beforeSha) || nullSha(afterSha)) {
    throw new Error("Ref inválida: before/after não podem ser o SHA nulo (branch nova ou deletada).");
  }
  if (beforeSha === afterSha) {
    throw new Error("Invalid Git compare range: before SHA equals after SHA.");
  }

  const { appId, privateKey } = getCredentials(input);
  const octokitFactory = getOctokitFactory(input.octokitFactory);
  const diffMaxBytes = input.diffMaxBytes ?? DEFAULT_DIFF_MAX_BYTES;
  const { octokit, owner, repo: repository } = await getInstallationOctokit({
    appId,
    privateKey,
    repo: input.repo,
    octokitFactory,
  });

  const basehead = `${beforeSha}...${afterSha}`;
  const compareResponse = await octokit.request<GitHubCompareData>(
    "GET /repos/{owner}/{repo}/compare/{basehead}",
    { owner, repo: repository, basehead },
  );
  const compare = compareResponse.data;

  const diffResponse = await octokit.request<string>(
    "GET /repos/{owner}/{repo}/compare/{basehead}",
    {
      owner,
      repo: repository,
      basehead,
      headers: { accept: "application/vnd.github.v3.diff" },
    },
  );

  const compareCommits: PushCommitEntry[] = compare.commits.map((c) => ({
    sha: c.sha,
    message: c.commit.message.trim(),
  }));
  const commitMessages = compareCommits.map((c) => c.message);
  const prNumbers = extractPrNumbersFromCommitMessages(commitMessages);

  const files = compare.files;
  const additions = files?.reduce((sum, f) => sum + (f.additions ?? 0), 0) ?? null;
  const deletions = files?.reduce((sum, f) => sum + (f.deletions ?? 0), 0) ?? null;
  const changedFiles = files?.length ?? null;

  return {
    compareCommits,
    commitMessages,
    prNumbers,
    totalCommits: compare.total_commits,
    compareUrl: compare.html_url,
    fileChangeSummary: buildFileChangeSummary(compare.files),
    additions,
    deletions,
    changedFiles,
    diff: truncateDiff(diffResponse.data, diffMaxBytes),
  };
};
