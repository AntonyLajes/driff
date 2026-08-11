import { createSign } from "node:crypto";

import { Octokit } from "@octokit/rest";

export interface RequestResult<TData> {
  data: TData;
}

export interface OctokitLike {
  request: <TData>(
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<RequestResult<TData>>;
  pulls: {
    get: (parameters: {
      owner: string;
      repo: string;
      pull_number: number;
    }) => Promise<RequestResult<unknown>>;
    listFiles: (parameters: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
      page: number;
    }) => Promise<RequestResult<unknown[]>>;
  };
}

interface RepositoryInstallationResponse {
  id: number;
}

interface InstallationTokenResponse {
  token: string;
}

const APP_JWT_TTL_SECONDS = 10 * 60;
const APP_JWT_IAT_SKEW_SECONDS = 60;

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

export const parseRepoCoordinates = (
  repo: string,
): { owner: string; repo: string } => {
  const [owner, repository] = repo.split("/");
  if (!owner || !repository) {
    throw new Error(
      `Invalid repository format "${repo}". Expected "owner/name".`,
    );
  }

  return { owner, repo: repository };
};

const getOctokitFactory = (
  octokitFactory?: (auth: string) => OctokitLike,
): ((auth: string) => OctokitLike) => {
  if (octokitFactory) {
    return octokitFactory;
  }

  return (auth) => new Octokit({ auth }) as unknown as OctokitLike;
};

export interface GetInstallationOctokitInput {
  appId: string;
  privateKey: string;
  repo: string;
  octokitFactory?: (auth: string) => OctokitLike;
}

export const getInstallationOctokit = async (
  input: GetInstallationOctokitInput,
): Promise<{ octokit: OctokitLike; owner: string; repo: string }> => {
  const { owner, repo: repository } = parseRepoCoordinates(input.repo);
  const createOctokit = getOctokitFactory(input.octokitFactory);
  const appJwt = createAppJwt(input.appId, input.privateKey);
  const appOctokit = createOctokit(appJwt);

  const installationResponse =
    await appOctokit.request<RepositoryInstallationResponse>(
      "GET /repos/{owner}/{repo}/installation",
      {
        owner,
        repo: repository,
      },
    );

  const installationTokenResponse =
    await appOctokit.request<InstallationTokenResponse>(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationResponse.data.id,
      },
    );

  const installationOctokit = createOctokit(
    installationTokenResponse.data.token,
  );

  return {
    octokit: installationOctokit,
    owner,
    repo: repository,
  };
};
