import type { IosPlistVersion } from "@/lib/plist-version.js";

const SEMVER_TAG =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export interface ParsedSemverTag {
  tagName: string;
  normalized: string;
  version: IosPlistVersion;
}

export const parseSemverTag = (
  value: string | null | undefined,
): ParsedSemverTag | null => {
  const tagName = value?.trim() ?? "";
  const match = SEMVER_TAG.exec(tagName);
  if (match === null) return null;

  const core = `${match[1]}.${match[2]}.${match[3]}`;
  const short = match[4] ? `${core}-${match[4]}` : core;
  const build = match[5] ?? "";
  return {
    tagName,
    normalized: build ? `${short}+${build}` : short,
    version: { short, build },
  };
};

export const isSemverTag = (value: string | null | undefined): boolean =>
  parseSemverTag(value) !== null;
