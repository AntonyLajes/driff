export const DEFAULT_HISTORY_EXCLUDED_PATHS = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Podfile.lock",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  "vendor/",
  "*.generated.*",
] as const;

const normalizePath = (value: string): string =>
  value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\/+|\/+$/gu, "");

const escapeRegex = (value: string): string =>
  value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");

const globRegex = (pattern: string): RegExp => {
  const normalized = normalizePath(pattern);
  let source = escapeRegex(normalized)
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  if (!normalized.includes("/")) {
    source = `(?:^|/)${source}`;
  } else {
    source = `^${source}`;
  }
  return new RegExp(`${source}$`, "iu");
};

export const cleanHistoryFilterValues = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )];
};

export const isHistoryActorExcluded = (
  actor: string | null,
  excludedActors: readonly string[],
): boolean => {
  const normalized = actor?.trim().toLocaleLowerCase();
  return Boolean(normalized) && excludedActors.some(
    (candidate) => candidate.trim().toLocaleLowerCase() === normalized,
  );
};

export const isHistoryPathExcluded = (
  path: string,
  excludedPaths: readonly string[],
): boolean => {
  const normalized = normalizePath(path);
  if (normalized.length === 0) {
    return false;
  }
  return excludedPaths.some((rawPattern) => {
    const pattern = rawPattern.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
    if (pattern.length === 0) {
      return false;
    }
    if (pattern.endsWith("/")) {
      const prefix = normalizePath(pattern);
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    return globRegex(pattern).test(normalized);
  });
};

const diffPath = (chunk: string): string | null => {
  const firstLine = chunk.split("\n", 1)[0] ?? "";
  const match = /^diff --git a\/(.+?) b\/(.+)$/u.exec(firstLine);
  return match?.[2] ?? match?.[1] ?? null;
};

export const filterHistoryDiff = (
  diff: string,
  excludedPaths: readonly string[],
): string => {
  if (excludedPaths.length === 0 || !diff.startsWith("diff --git ")) {
    return diff;
  }
  return diff
    .split(/(?=^diff --git )/gmu)
    .filter((chunk) => {
      const path = diffPath(chunk);
      return path === null || !isHistoryPathExcluded(path, excludedPaths);
    })
    .join("")
    .trim();
};

export const filterHistoryFileSummary = (
  summary: string,
  excludedPaths: readonly string[],
): string =>
  summary
    .split("\n")
    .filter((line) => {
      const separator = line.indexOf(": ");
      if (separator < 0) {
        return true;
      }
      return !isHistoryPathExcluded(line.slice(separator + 2), excludedPaths);
    })
    .join("\n")
    .trim();
