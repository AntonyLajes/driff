import type { IosPlistVersion } from "@/lib/plist-version.js";

/** Reads the standard SemVer marker used by Node and web projects. */
export const execute = (rawPackageJson: string): IosPlistVersion | null => {
  try {
    const parsed = JSON.parse(rawPackageJson) as { version?: unknown };
    if (typeof parsed.version !== "string") {
      return null;
    }
    const version = parsed.version.trim();
    return version.length > 0 ? { short: version, build: "" } : null;
  } catch {
    return null;
  }
};
