import { z } from "zod";

import type { IosPlistVersion } from "@/lib/plist-version.js";

const expoJsonSchema = z.object({
  expo: z
    .object({
      version: z.string().optional(),
      ios: z.object({ buildNumber: z.union([z.string(), z.number()]).optional() }).optional(),
      android: z
        .object({
          versionCode: z.union([z.number(), z.string()]).optional(),
        })
        .optional(),
    })
    .passthrough(),
});

/** Removes `/* ... *\/` blocks only (conservative; avoids breaking `//` inside strings). */
const stripBlockComments = (source: string): string => {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
};

const parseAppJson = (raw: string): IosPlistVersion | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const r = expoJsonSchema.safeParse(parsed);
  if (!r.success) {
    return null;
  }
  const ex = r.data.expo;
  const short = ex.version?.trim() ?? "";
  const iosRaw = ex.ios?.buildNumber;
  const iosBuild =
    iosRaw === undefined || iosRaw === null ? "" : String(iosRaw).trim();
  const androidRaw = ex.android?.versionCode;
  const androidBuild =
    androidRaw === undefined || androidRaw === null ? "" : String(androidRaw).trim();
  const build = iosBuild.length > 0 ? iosBuild : androidBuild;
  if (!short && !build) {
    return null;
  }
  return { short, build };
};

/**
 * Best-effort parse for `app.config.js` / `app.config.ts` (static-looking exports only).
 * Does not execute the module; use `app.json` when possible for reliability.
 */
const parseConfigModuleText = (raw: string): IosPlistVersion | null => {
  const cleaned = stripBlockComments(raw);
  const expoVersion = cleaned.match(/expo\s*:\s*\{[\s\S]*?\bversion\s*:\s*['"]([^'"]+)['"]/m);
  const short = expoVersion?.[1]?.trim() ?? "";
  const iosBuild =
    cleaned.match(/ios\s*:\s*\{[\s\S]*?\bbuildNumber\s*:\s*['"]([^'"]*)['"]/m)?.[1]?.trim() ?? "";
  const androidVc = cleaned.match(/android\s*:\s*\{[\s\S]*?\bversionCode\s*:\s*(\d+)/m)?.[1];
  const build = iosBuild.length > 0 ? iosBuild : (androidVc ?? "");
  if (!short && !build) {
    return null;
  }
  return { short, build };
};

/**
 * Reads Expo-style marketing version + native build counters from `app.json` or
 * `app.config.js` / `app.config.ts` text (see Expo docs: expo.version, ios.buildNumber, android.versionCode).
 */
export const execute = (raw: string, filename: string): IosPlistVersion | null => {
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith(".json")) {
    return parseAppJson(raw);
  }
  if (lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".mjs")) {
    return parseConfigModuleText(raw);
  }
  return parseConfigModuleText(raw);
};
