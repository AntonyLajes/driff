import { z } from "zod";

/** Valores persistidos em `workspace_settings.release_project_kind` / env `RELEASE_PROJECT_KIND`. */
export const releaseProjectKindSchema = z.enum([
  "ios_plist",
  "ios_pbx",
  "react_native_expo",
  "node_package",
  "android_gradle",
  "flutter_pubspec",
  "python_pyproject",
  "rust_cargo",
  "java_maven",
  "java_gradle",
]);

export type ReleaseProjectKind = z.infer<typeof releaseProjectKindSchema>;

const SUPPORTED: ReadonlySet<ReleaseProjectKind> = new Set([
  "ios_plist",
  "ios_pbx",
  "react_native_expo",
  "node_package",
  "android_gradle",
  "flutter_pubspec",
  "python_pyproject",
  "rust_cargo",
  "java_maven",
  "java_gradle",
]);

export const isSupportedReleaseProjectKind = (
  kind: ReleaseProjectKind,
): boolean => {
  return SUPPORTED.has(kind);
};

export const parseReleaseProjectKind = (raw: string): ReleaseProjectKind => {
  return releaseProjectKindSchema.parse(raw.trim().toLowerCase());
};

export interface LegacyReleasePaths {
  releaseInfoPlistPath: string | null;
  releaseProjectPbxprojPath: string | null;
  releaseExpoAppConfigPath: string | null;
}

/**
 * Mapeia tipo de projeto + um único ficheiro no repo para os campos legados usados por `gather-release-context`.
 */
export const applyReleaseKindAndFilePath = (
  kind: ReleaseProjectKind,
  repoRelativePath: string,
): LegacyReleasePaths => {
  const path = repoRelativePath.trim();
  if (!path) {
    throw new Error(
      "release_version_file_path must be a non-empty repo-relative path.",
    );
  }
  switch (kind) {
    case "ios_plist":
      return {
        releaseInfoPlistPath: path,
        releaseProjectPbxprojPath: null,
        releaseExpoAppConfigPath: null,
      };
    case "ios_pbx":
      return {
        releaseInfoPlistPath: "",
        releaseProjectPbxprojPath: path,
        releaseExpoAppConfigPath: null,
      };
    case "react_native_expo":
      return {
        releaseInfoPlistPath: "",
        releaseProjectPbxprojPath: null,
        releaseExpoAppConfigPath: path,
      };
    case "node_package":
    case "android_gradle":
    case "flutter_pubspec":
    case "python_pyproject":
    case "rust_cargo":
    case "java_maven":
    case "java_gradle":
      return {
        releaseInfoPlistPath: null,
        releaseProjectPbxprojPath: null,
        releaseExpoAppConfigPath: null,
      };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
};

/** Paths a observar em webhooks `push` (alteração em qualquer um dispara release). */
export const collectVersionWatchPaths = (
  releaseInfoPlistPath: string | null,
  releaseProjectPbxprojPath: string | null,
  releaseExpoAppConfigPath: string | null,
  releaseVersionFilePath: string | null = null,
): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [
    releaseInfoPlistPath,
    releaseProjectPbxprojPath,
    releaseExpoAppConfigPath,
    releaseVersionFilePath,
  ]) {
    const t = raw?.trim();
    if (t && t.length > 0 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
};

/**
 * Para UI / telemetria: infere tipo + ficheiro a partir dos campos legados (prioridade Expo → pbx → plist).
 */
export const inferKindAndPathFromLegacyPaths = (
  releaseInfoPlistPath: string | null,
  releaseProjectPbxprojPath: string | null,
  releaseExpoAppConfigPath: string | null,
): { kind: ReleaseProjectKind; path: string } | null => {
  const expo = releaseExpoAppConfigPath?.trim();
  if (expo) {
    return { kind: "react_native_expo", path: expo };
  }
  const pbx = releaseProjectPbxprojPath?.trim();
  if (pbx) {
    return { kind: "ios_pbx", path: pbx };
  }
  const plist = releaseInfoPlistPath?.trim();
  if (plist) {
    return { kind: "ios_plist", path: plist };
  }
  return null;
};
