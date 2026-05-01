/**
 * Lê chaves de string em plist XML (iOS) comuns de versão.
 * Não suporta plist binário; use XML no repositório ou converta o fluxo.
 */

export interface IosPlistVersion {
  short: string;
  build: string;
}

const getString = (content: string, key: string): string | null => {
  const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const re = new RegExp(
    `<key>${escaped}</key>\\s*<string>([^<]*)</string>`,
    "i",
  );
  const m = re.exec(content);
  const v = m?.[1]?.trim();
  if (!v) {
    return null;
  }
  return v;
};

export const execute = (rawPlist: string): IosPlistVersion | null => {
  const short = getString(rawPlist, "CFBundleShortVersionString");
  const build = getString(rawPlist, "CFBundleVersion");
  if (short === null && build === null) {
    return null;
  }
  return { short: short ?? "", build: build ?? "" };
};

/** `Info.plist` com `$(MARKETING_VERSION)` não muda com bump só no pbx. */
export const isPlaceholderPlistVersion = (v: IosPlistVersion): boolean => {
  const s = v.short.trim();
  const b = v.build.trim();
  const p = (x: string) => x.length > 0 && (x.startsWith("$(") || x.startsWith("${"));
  if (p(s) || p(b)) {
    return true;
  }
  if (s.includes("MARKETING_VERSION") || s.includes("CURRENT_PROJECT_VERSION")) {
    return true;
  }
  return false;
};

export const toVersionKey = (v: IosPlistVersion): string => {
  if (v.short && v.build) {
    return `${v.short}+${v.build}`;
  }
  if (v.short) {
    return v.short;
  }
  if (v.build) {
    return v.build;
  }
  return "unknown";
};
