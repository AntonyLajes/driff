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
