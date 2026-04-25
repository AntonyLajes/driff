import { createSign } from "node:crypto";

import { Octokit } from "@octokit/rest";

import { execute as loadEnv } from "@/config/env.js";
import type { PullRequestEvent, PullRequestEventFile, Source } from "@/sources/source.js";

const DEFAULT_DIFF_MAX_BYTES = 200 * 1024;
const APP_JWT_TTL_SECONDS = 10 * 60;
const APP_JWT_IAT_SKEW_SECONDS = 60;

interface RequestResult<TData> {
  data: TData;
}

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

interface RepositoryInstallationResponse {
  id: number;
}

interface InstallationTokenResponse {
  token: string;
}

export interface OctokitLike {
  request: <TData>(route: string, parameters?: Record<string, unknown>) => Promise<RequestResult<TData>>;
  pulls: {
    get: (parameters: {
      owner: string;
      repo: string;
      pull_number: number;
    }) => Promise<RequestResult<PullRequestResponse>>;
    listFiles: (parameters: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
      page: number;
    }) => Promise<RequestResult<PullRequestFileResponse[]>>;
  };
}

export interface ExecuteInput {
  appId?: string;
  privateKey?: string;
  diffMaxBytes?: number;
  octokitFactory?: (auth: string) => OctokitLike;
}

interface RepoCoordinates {
  owner: string;
  repo: string;
}

const toBase64Url = (value: string): string => {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const normalizePrivateKey = (key: string): string => {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
};

const createAppJwt = (appId: string, privateKey: string): string => {
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowInSeconds - APP_JWT_IAT_SKEW_SECONDS,
    exp: nowInSeconds + APP_JWT_TTL_SECONDS,
    iss: appId,
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign("RSA-SHA256")
    .update(unsignedToken)
    .end()
    .sign(normalizePrivateKey(privateKey), "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return `${unsignedToken}.${signature}`;
};

const parseRepoCoordinates = (repo: string): RepoCoordinates => {
  const [owner, repository] = repo.split("/");
  if (!owner || !repository) {
    throw new Error(`Invalid repository format "${repo}". Expected "owner/name".`);
  }

  return { owner, repo: repository };
};

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

  return (auth) => new Octokit({ auth });
};

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
  const createOctokit = getOctokitFactory(input.octokitFactory);
  const diffMaxBytes = input.diffMaxBytes ?? DEFAULT_DIFF_MAX_BYTES;

  return {
    fetchPullRequest: async (repo, prNumber): Promise<PullRequestEvent> => {
      const { owner, repo: repository } = parseRepoCoordinates(repo);
      const appJwt = createAppJwt(appId, privateKey);
      const appOctokit = createOctokit(appJwt);

      const installationResponse = await appOctokit.request<RepositoryInstallationResponse>(
        "GET /repos/{owner}/{repo}/installation",
        {
          owner,
          repo: repository,
        },
      );

      const installationTokenResponse = await appOctokit.request<InstallationTokenResponse>(
        "POST /app/installations/{installation_id}/access_tokens",
        {
          installation_id: installationResponse.data.id,
        },
      );

      const installationOctokit = createOctokit(installationTokenResponse.data.token);
      const prResponse = await installationOctokit.pulls.get({
        owner,
        repo: repository,
        pull_number: prNumber,
      });

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

        files.push(...filesResponse.data);
        if (filesResponse.data.length < 100) {
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

      if (!prResponse.data.merged_at) {
        throw new Error(`Pull request ${repo}#${prNumber} is not merged.`);
      }

      return {
        repo,
        prNumber,
        title: prResponse.data.title,
        body: prResponse.data.body,
        author: prResponse.data.user?.login ?? "unknown",
        mergedAt: new Date(prResponse.data.merged_at),
        headSha: prResponse.data.head.sha,
        baseBranch: prResponse.data.base.ref,
        diff: truncateDiff(diffResponse.data, diffMaxBytes),
        files: mapPullRequestFiles(files),
      };
    },
  };
};
