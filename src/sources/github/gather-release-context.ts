import { execute as loadEnv } from "@/config/env.js";
import {
  getInstallationOctokit,
  type OctokitLike,
} from "@/sources/github/github-installation.js";
import { execute as parseExpoAppConfig } from "@/lib/expo-app-config-version.js";
import { execute as parsePackageJsonVersion } from "@/lib/package-json-version.js";
import { execute as parsePbxVersion } from "@/lib/pbxproj-version.js";
import {
  type IosPlistVersion,
  execute as parsePlist,
  isPlaceholderPlistVersion,
  toVersionKey,
} from "@/lib/plist-version.js";

import { Octokit } from "@octokit/rest";

export interface CompareCommit {
  sha: string;
  commit: { message: string };
}

export interface GitHubCompareData {
  total_commits: number;
  commits: CompareCommit[];
  files?: Array<{ filename: string; status: string; additions?: number; deletions?: number }>;
  html_url: string;
}

const nullSha = (sha: string): boolean => {
  return /^0+$/.test(sha);
};

const decodeFileContent = (data: { type: string; encoding?: string; content?: string }): string => {
  if (data.type !== "file" || !data.content || data.encoding !== "base64") {
    throw new Error("Expected a single file with base64 content from the GitHub contents API.");
  }
  return Buffer.from(data.content, "base64").toString("utf8");
};

export const extractPrNumbersFromCommitMessages = (messages: string[]): number[] => {
  const seen = new Set<number>();
  const mergeRe = /^Merge pull request #(\d+)/im;
  const squashRe = /\(#(\d+)\)\s*$/m;

  for (const msg of messages) {
    const m1 = mergeRe.exec(msg);
    if (m1?.[1]) {
      const n = Number(m1[1]);
      if (Number.isInteger(n) && n > 0) {
        seen.add(n);
      }
      continue;
    }
    const m2 = squashRe.exec(msg);
    if (m2?.[1]) {
      const n = Number(m2[1]);
      if (Number.isInteger(n) && n > 0) {
        seen.add(n);
      }
    }
  }

  return [...seen].sort((a, b) => a - b);
};

const buildFileChangeSummary = (files: Array<{ filename: string; status: string }> | undefined): string => {
  if (!files || files.length === 0) {
    return "Nenhum arquivo listado no compare (ou alterações apenas em binário).";
  }
  const lines = files.slice(0, 50).map((f) => `${f.status}: ${f.filename}`);
  if (files.length > 50) {
    lines.push(`… e mais ${files.length - 50} arquivos.`);
  }
  return lines.join("\n");
};

export interface CompareCommitEntry {
  sha: string;
  message: string;
}

export interface ReleaseContext {
  beforeVersion: IosPlistVersion | null;
  afterVersion: IosPlistVersion;
  previousVersionKey: string | null;
  newVersionKey: string;
  /** Commits incluídos no intervalo GitHub Compare (ordenados pela API). */
  compareCommits: CompareCommitEntry[];
  commitMessages: string[];
  prNumbers: number[];
  totalCommits: number;
  compareUrl: string;
  fileChangeSummary: string;
}

export interface ExecuteInput {
  appId?: string;
  privateKey?: string;
  repo: string;
  beforeSha: string;
  afterSha: string;
  infoPlistPath: string;
  /**
   * When set, GitHub compare uses this SHA as the left endpoint instead of {@link beforeSha}.
   * Version files are still read at {@link beforeSha} and {@link afterSha} (webhook SHAs).
   */
  compareBeforeSha?: string | null;
  /**
   * Quando definido, lê `MARKETING_VERSION` e `CURRENT_PROJECT_VERSION` deste
   * ficheiro em vez de confiar no Info.plist (útil com `$(MARKETING_VERSION)` no XML).
   */
  projectPbxprojPath?: string | null;
  /**
   * Expo / React Native: path to `app.json` or `app.config.*` — version comes from here when set
   * (takes precedence over plist / pbxproj).
   */
  expoAppConfigPath?: string | null;
  /** Unified project kind used for non-mobile version markers such as package.json. */
  releaseProjectKind?: string | null;
  /** Repo-relative version file paired with releaseProjectKind. */
  releaseVersionFilePath?: string | null;
  octokitFactory?: (auth: string) => OctokitLike;
}

const getCredentials = (input: ExecuteInput): { appId: string; privateKey: string } => {
  if (input.appId && input.privateKey) {
    return { appId: input.appId, privateKey: input.privateKey };
  }
  const env = loadEnv();
  return { appId: input.appId ?? env.GITHUB_APP_ID, privateKey: input.privateKey ?? env.GITHUB_APP_PRIVATE_KEY };
};

const getOctokitFactory = (
  factory?: (auth: string) => OctokitLike,
): ((auth: string) => OctokitLike) => {
  if (factory) {
    return factory;
  }
  return (auth) => new Octokit({ auth }) as unknown as OctokitLike;
};

const fetchFileTextAt = async (input: {
  octokit: OctokitLike;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}): Promise<string> => {
  const response = await input.octokit.request<{
    type: string;
    encoding?: string;
    content?: string;
  }>("GET /repos/{owner}/{repo}/contents/{path}", {
    owner: input.owner,
    repo: input.repo,
    path: input.path,
    ref: input.ref,
  });
  return decodeFileContent(response.data);
};

/**
 * O GitHub "compare" API usa o intervalo `base...head` (inclusive).
 */
const compareShas = async (input: {
  octokit: OctokitLike;
  owner: string;
  repo: string;
  beforeSha: string;
  afterSha: string;
}): Promise<GitHubCompareData> => {
  const basehead = `${input.beforeSha}...${input.afterSha}`;
  const response = await input.octokit.request<GitHubCompareData>("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner: input.owner,
    repo: input.repo,
    basehead,
  });
  return response.data;
};

export const execute = async (input: ExecuteInput): Promise<ReleaseContext> => {
  const trimmedBefore = input.beforeSha.trim();
  const trimmedAfter = input.afterSha.trim();
  const compareOverride = input.compareBeforeSha?.trim();
  const compareLeft =
    compareOverride !== undefined && compareOverride !== null && compareOverride.length > 0
      ? compareOverride
      : trimmedBefore;

  if (nullSha(trimmedAfter) || nullSha(trimmedBefore) || nullSha(compareLeft)) {
    throw new Error("Ref inválida: before/after não podem ser o SHA nulo (branch nova ou deletada).");
  }
  if (compareLeft === trimmedAfter) {
    throw new Error("Invalid Git compare range: compare base SHA equals after SHA.");
  }

  const { appId, privateKey } = getCredentials(input);
  const octokitFactory = getOctokitFactory(input.octokitFactory);
  const { octokit, owner, repo: repository } = await getInstallationOctokit({
    appId,
    privateKey,
    repo: input.repo,
    octokitFactory,
  });

  const pbx = input.projectPbxprojPath?.trim() ?? "";
  const compare = await compareShas({
    octokit,
    owner,
    repo: repository,
    beforeSha: compareLeft,
    afterSha: trimmedAfter,
  });

  let beforeVersion: IosPlistVersion | null;
  let afterVersion: IosPlistVersion;
  const unifiedKind = input.releaseProjectKind?.trim() ?? "";
  const unifiedPath = input.releaseVersionFilePath?.trim() ?? "";
  const expoPath = input.expoAppConfigPath?.trim() ?? "";
  if (unifiedKind === "node_package") {
    if (unifiedPath.length === 0) {
      throw new Error("package.json path is required for node_package releases.");
    }
    const [beforePackage, afterPackage] = await Promise.all([
      fetchFileTextAt({
        octokit,
        owner,
        repo: repository,
        path: unifiedPath,
        ref: trimmedBefore,
      }),
      fetchFileTextAt({
        octokit,
        owner,
        repo: repository,
        path: unifiedPath,
        ref: trimmedAfter,
      }),
    ]);
    const b = parsePackageJsonVersion(beforePackage);
    const a = parsePackageJsonVersion(afterPackage);
    if (!a) {
      throw new Error(
        "Could not read a non-empty version field from package.json at the after ref.",
      );
    }
    beforeVersion = b;
    afterVersion = a;
  } else if (expoPath.length > 0) {
    const [beforeExpo, afterExpo] = await Promise.all([
      fetchFileTextAt({ octokit, owner, repo: repository, path: expoPath, ref: trimmedBefore }),
      fetchFileTextAt({ octokit, owner, repo: repository, path: expoPath, ref: trimmedAfter }),
    ]);
    const fileName = expoPath.includes("/") ? expoPath.split("/").pop() ?? expoPath : expoPath;
    const b = parseExpoAppConfig(beforeExpo, fileName);
    const a = parseExpoAppConfig(afterExpo, fileName);
    if (!a) {
      throw new Error(
        "Could not read expo.version (and ios.buildNumber / android.versionCode) from the Expo app config at the after ref.",
      );
    }
    beforeVersion = b;
    afterVersion = a;
  } else if (pbx.length > 0) {
    const [beforePbx, afterPbx] = await Promise.all([
      fetchFileTextAt({ octokit, owner, repo: repository, path: pbx, ref: trimmedBefore }),
      fetchFileTextAt({ octokit, owner, repo: repository, path: pbx, ref: trimmedAfter }),
    ]);
    const b = parsePbxVersion(beforePbx);
    const a = parsePbxVersion(afterPbx);
    if (!a) {
      throw new Error(
        "Não foi possível inferir MARKETING_VERSION / CURRENT_PROJECT_VERSION no project.pbxproj (destino).",
      );
    }
    beforeVersion = b;
    afterVersion = a;
  } else {
    const plistPath = input.infoPlistPath.trim();
    if (!plistPath) {
      throw new Error(
        "infoPlistPath is required when Expo app config and project.pbxproj paths are unset; configure release_project_kind + release_version_file_path (or legacy plist / pbx / expo columns).",
      );
    }
    const [beforeText, afterText] = await Promise.all([
      fetchFileTextAt({ octokit, owner, repo: repository, path: plistPath, ref: trimmedBefore }),
      fetchFileTextAt({ octokit, owner, repo: repository, path: plistPath, ref: trimmedAfter }),
    ]);
    const b = parsePlist(beforeText);
    const a = parsePlist(afterText);
    if (!a) {
      throw new Error("Não foi possível ler CFBundleShortVersionString / CFBundleVersion no Info.plist (destino).");
    }
    if (isPlaceholderPlistVersion(a) || (b !== null && isPlaceholderPlistVersion(b))) {
      throw new Error(
        "O Info.plist usa variáveis Xcode (ex.: $(MARKETING_VERSION)); defina RELEASE_PROJECT_PBXPROJ_PATH para o project.pbxproj onde a versão é realmente alterada.",
      );
    }
    beforeVersion = b;
    afterVersion = a;
  }

  const newVersionKey = toVersionKey(afterVersion);
  const previousVersionKey = beforeVersion ? toVersionKey(beforeVersion) : null;
  const commitMessages = compare.commits.map((c) => c.commit.message.trim());
  const compareCommits: CompareCommitEntry[] = compare.commits.map((c) => ({
    sha: c.sha,
    message: c.commit.message.trim(),
  }));
  const prNumbers = extractPrNumbersFromCommitMessages(commitMessages);

  return {
    beforeVersion,
    afterVersion,
    previousVersionKey,
    newVersionKey,
    compareCommits,
    commitMessages,
    prNumbers,
    totalCommits: compare.total_commits,
    compareUrl: compare.html_url,
    fileChangeSummary: buildFileChangeSummary(compare.files),
  };
};
