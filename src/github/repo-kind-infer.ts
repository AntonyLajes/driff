import type { Octokit } from "@octokit/rest";

export type InferenceConfidence = "high" | "medium" | "low";

export interface RepoKindInference {
  suggestedKind: string | null;
  confidence: InferenceConfidence | null;
  defaultBranch: string | null;
  versionFilePath: string | null;
  signals: string[];
}

const decodeFileContent = (encoding: string, content: string): string | null => {
  if (encoding !== "base64") {
    return null;
  }
  try {
    return Buffer.from(content, "base64").toString("utf8");
  } catch {
    return null;
  }
};

const parseOwnerRepo = (fullName: string): { owner: string; repo: string } => {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) {
    throw new Error("invalid_full_name");
  }
  const owner = fullName.slice(0, slash);
  const repo = fullName.slice(slash + 1);
  if (!owner || !repo) {
    throw new Error("invalid_full_name");
  }
  return { owner, repo };
};

/**
 * Best-effort project kind from lightweight GitHub API reads (no full clone).
 */
export const inferRepoKind = async (
  octokit: Octokit,
  fullName: string,
): Promise<RepoKindInference> => {
  const signals: string[] = [];
  const { owner, repo } = parseOwnerRepo(fullName.trim());

  const { data: meta } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = typeof meta.default_branch === "string" ? meta.default_branch : null;
  signals.push(`github:${meta.full_name}`);

  const root = await octokit.rest.repos.getContent({ owner, repo, path: "" });
  if (!Array.isArray(root.data)) {
    return {
      suggestedKind: null,
      confidence: null,
      defaultBranch,
      versionFilePath: null,
      signals: [...signals, "root_not_directory_listing"],
    };
  }

  const fileNames = new Set(
    root.data.filter((e) => e.type === "file").map((e) => String(e.name)),
  );
  const dirNames = new Set(
    root.data.filter((e) => e.type === "dir").map((e) => String(e.name)),
  );

  const readTextFile = async (path: string): Promise<string | null> => {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
      if (!("content" in data) || typeof data.content !== "string" || typeof data.encoding !== "string") {
        return null;
      }
      return decodeFileContent(data.encoding, data.content);
    } catch {
      return null;
    }
  };

  if (fileNames.has("pubspec.yaml")) {
    return {
      suggestedKind: "flutter_pubspec",
      confidence: "high",
      defaultBranch,
      versionFilePath: "pubspec.yaml",
      signals: [...signals, "file:pubspec.yaml"],
    };
  }

  const expoConfigCandidates = [
    "app.json",
    "app.config.json",
    "app.config.ts",
    "app.config.js",
  ] as const;

  if (fileNames.has("package.json")) {
    const pkgRaw = await readTextFile("package.json");
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.expo !== undefined) {
          for (const p of expoConfigCandidates) {
            if (fileNames.has(p)) {
              return {
                suggestedKind: "react_native_expo",
                confidence: "high",
                defaultBranch,
                versionFilePath: p,
                signals: [...signals, "dependency:expo", `file:${p}`],
              };
            }
          }
          return {
            suggestedKind: "react_native_expo",
            confidence: "low",
            defaultBranch,
            versionFilePath: null,
            signals: [...signals, "dependency:expo", "missing_expo_config_file"],
          };
        }
        if (deps["react-native"] !== undefined && dirNames.has("android")) {
          const gradlePath = "android/app/build.gradle";
          try {
            await octokit.rest.repos.getContent({ owner, repo, path: gradlePath });
            return {
              suggestedKind: "android_gradle",
              confidence: "low",
              defaultBranch,
              versionFilePath: gradlePath,
              signals: [...signals, "dependency:react-native", `file:${gradlePath}`],
            };
          } catch {
            signals.push("react_native_no_android_gradle");
          }
        }
        if (typeof (pkg as { version?: unknown }).version === "string") {
          const version = (pkg as { version: string }).version.trim();
          if (version.length > 0) {
            return {
              suggestedKind: "node_package",
              confidence: "high",
              defaultBranch,
              versionFilePath: "package.json",
              signals: [...signals, "file:package.json", "field:version"],
            };
          }
        }
      } catch {
        signals.push("package_json_invalid");
      }
    }
  }

  if (dirNames.has("ios")) {
    try {
      const iosRoot = await octokit.rest.repos.getContent({ owner, repo, path: "ios" });
      if (Array.isArray(iosRoot.data)) {
        const directPlist = iosRoot.data.find((e) => e.type === "file" && e.name === "Info.plist");
        if (directPlist && "path" in directPlist && typeof directPlist.path === "string") {
          return {
            suggestedKind: "ios_plist",
            confidence: "medium",
            defaultBranch,
            versionFilePath: directPlist.path,
            signals: [...signals, `file:${directPlist.path}`],
          };
        }
        const firstSub = iosRoot.data.find((e) => e.type === "dir");
        if (firstSub && "name" in firstSub && typeof firstSub.name === "string") {
          const subPath = `ios/${firstSub.name}/Info.plist`;
          try {
            await octokit.rest.repos.getContent({ owner, repo, path: subPath });
            return {
              suggestedKind: "ios_plist",
              confidence: "low",
              defaultBranch,
              versionFilePath: subPath,
              signals: [...signals, `file:${subPath}`],
            };
          } catch {
            signals.push("ios_nested_plist_not_found");
          }
        }
      }
    } catch {
      signals.push("ios_folder_unreadable");
    }
  }

  const xcodeprojDir = root.data.find(
    (e) => e.type === "dir" && String(e.name).endsWith(".xcodeproj"),
  );
  if (xcodeprojDir && "name" in xcodeprojDir && typeof xcodeprojDir.name === "string") {
    const rel = `${xcodeprojDir.name}/project.pbxproj`;
    try {
      await octokit.rest.repos.getContent({ owner, repo, path: rel });
      return {
        suggestedKind: "ios_pbx",
        confidence: "medium",
        defaultBranch,
        versionFilePath: rel,
        signals: [...signals, `file:${rel}`],
      };
    } catch {
      signals.push("pbxproj_missing");
    }
  }

  if (dirNames.has("android")) {
    const gradlePath = "android/app/build.gradle";
    try {
      await octokit.rest.repos.getContent({ owner, repo, path: gradlePath });
      return {
        suggestedKind: "android_gradle",
        confidence: "medium",
        defaultBranch,
        versionFilePath: gradlePath,
        signals: [...signals, `file:${gradlePath}`],
      };
    } catch {
      signals.push("android_gradle_missing");
    }
  }

  return {
    suggestedKind: null,
    confidence: null,
    defaultBranch,
    versionFilePath: null,
    signals,
  };
};
