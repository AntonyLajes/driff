import type { IosPlistVersion } from "@/lib/plist-version.js";

const stripValue = (raw: string): string => {
  return raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
};

const isXcodeSubstitution = (v: string): boolean => {
  return v.startsWith("$(") || v.startsWith("${");
};

/**
 * Lê a primeira ocorrência “literal” de MARKETING_VERSION e CURRENT_PROJECT_VERSION
 * no `project.pbxproj`. Ignora valores do tipo `$(inherited)` / `$(MARKETING_VERSION)`.
 * Quando várias ocorrências existem, usa a **última** literal (comum: Debug/Release iguais).
 */
export const execute = (rawPbx: string): IosPlistVersion | null => {
  const mkt = [...rawPbx.matchAll(/MARKETING_VERSION\s*=\s*([^;\n]+);/g)];
  const cur = [...rawPbx.matchAll(/CURRENT_PROJECT_VERSION\s*=\s*([^;\n]+);/g)];

  const pickLastLiteral = (matches: RegExpMatchArray[]): string | null => {
    let best: string | null = null;
    for (const m of matches) {
      const v = stripValue(m[1] ?? "");
      if (v.length === 0) {
        continue;
      }
      if (isXcodeSubstitution(v)) {
        continue;
      }
      best = v;
    }
    return best;
  };

  const short = pickLastLiteral(mkt);
  const build = pickLastLiteral(cur);
  if (short === null && build === null) {
    return null;
  }
  return { short: short ?? "", build: build ?? "" };
};
