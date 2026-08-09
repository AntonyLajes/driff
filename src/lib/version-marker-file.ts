import type { IosPlistVersion } from "@/lib/plist-version.js";

const quotedValue = (value: string): string =>
  value
    .trim()
    .replace(/^['"]|['"]$/gu, "")
    .trim();

const sectionVersion = (
  raw: string,
  acceptedSections: ReadonlySet<string>,
): string | null => {
  let currentSection = "";
  for (const line of raw.split(/\r?\n/u)) {
    const section = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (section?.[1] !== undefined) {
      currentSection = section[1].trim().toLowerCase();
      continue;
    }
    if (!acceptedSections.has(currentSection)) continue;
    const version = /^\s*version\s*=\s*([^#]+?)(?:\s*#.*)?$/u.exec(line);
    if (version?.[1] !== undefined) {
      const parsed = quotedValue(version[1]);
      if (parsed.length > 0) return parsed;
    }
  }
  return null;
};

const fromShortAndBuild = (
  short: string | null,
  build = "",
): IosPlistVersion | null =>
  short !== null && short.trim().length > 0
    ? { short: short.trim(), build: build.trim() }
    : null;

const parseFlutter = (raw: string): IosPlistVersion | null => {
  const match = /^\s*version\s*:\s*([^\s#]+).*$/mu.exec(raw);
  if (match?.[1] === undefined) return null;
  const [short = "", build = ""] = quotedValue(match[1]).split("+", 2);
  return fromShortAndBuild(short, build);
};

const parseAndroid = (raw: string): IosPlistVersion | null => {
  const short =
    /\bversionName\s*(?:=\s*)?["']([^"']+)["']/u.exec(raw)?.[1] ?? null;
  const build = /\bversionCode\s*(?:=\s*)?(\d+)/u.exec(raw)?.[1] ?? "";
  return fromShortAndBuild(short, build);
};

const parseMaven = (raw: string): IosPlistVersion | null => {
  const withoutParent = raw.replace(/<parent\b[^>]*>[\s\S]*?<\/parent>/giu, "");
  const short =
    /<version\b[^>]*>\s*([^<\s][^<]*?)\s*<\/version>/iu.exec(
      withoutParent,
    )?.[1] ?? null;
  return fromShortAndBuild(short);
};

const parseGradle = (raw: string): IosPlistVersion | null => {
  const short = /^\s*version\s*=\s*["']([^"']+)["']/mu.exec(raw)?.[1] ?? null;
  return fromShortAndBuild(short);
};

export const parseVersionMarkerFile = (
  kind: string,
  raw: string,
): IosPlistVersion | null => {
  switch (kind) {
    case "python_pyproject":
      return fromShortAndBuild(
        sectionVersion(raw, new Set(["project", "tool.poetry"])),
      );
    case "rust_cargo":
      return fromShortAndBuild(sectionVersion(raw, new Set(["package"])));
    case "flutter_pubspec":
      return parseFlutter(raw);
    case "android_gradle":
      return parseAndroid(raw);
    case "java_maven":
      return parseMaven(raw);
    case "java_gradle":
      return parseGradle(raw);
    default:
      return null;
  }
};
