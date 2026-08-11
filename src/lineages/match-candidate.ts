export interface ChangeFingerprintInput {
  title: string;
  category: string;
  areaSlugs: string[];
  filePaths: string[];
}

export interface ChangeFingerprint {
  terms: string[];
  areaSlugs: string[];
  fileScopes: string[];
}

export type SuggestedLineageRelation =
  | "introduced"
  | "modified"
  | "fixed"
  | "removed"
  | "restored"
  | "other";

const ACTION_TERMS = new Set([
  "add",
  "added",
  "adding",
  "adicionar",
  "adiciona",
  "adicionado",
  "improve",
  "improved",
  "improving",
  "melhorar",
  "melhora",
  "update",
  "updated",
  "updating",
  "atualizar",
  "atualiza",
  "fix",
  "fixed",
  "fixing",
  "corrigir",
  "corrige",
  "remove",
  "removed",
  "removing",
  "remover",
  "remove",
  "restore",
  "restored",
  "restoring",
  "restaurar",
  "restaura",
  "refactor",
  "refactored",
]);

const STOP_TERMS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "the",
  "to",
  "with",
  "de",
  "da",
  "do",
  "das",
  "dos",
  "e",
  "em",
  "na",
  "no",
  "para",
  "por",
  "com",
]);

const normalizeText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const singularize = (term: string): string => {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith("s")) return term.slice(0, -1);
  return term;
};

const uniqueSorted = (values: string[]): string[] =>
  Array.from(new Set(values)).sort();

const titleTerms = (title: string): string[] =>
  uniqueSorted(
    normalizeText(title)
      .split(/[^a-z0-9]+/gu)
      .map(singularize)
      .filter(
        (term) =>
          term.length >= 2 && !ACTION_TERMS.has(term) && !STOP_TERMS.has(term),
      ),
  );

const fileScope = (path: string): string => {
  const normalized = normalizeText(path).replace(/^\/+|\/+$/gu, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return normalized;
  const fileName = parts.at(-1)?.replace(/\.[^.]+$/u, "") ?? "";
  const parent = parts.at(-2) ?? "";
  return `${parent}/${fileName}`;
};

export const fingerprintChange = (
  input: ChangeFingerprintInput,
): ChangeFingerprint => ({
  terms: titleTerms(input.title),
  areaSlugs: uniqueSorted(input.areaSlugs.map(normalizeText).filter(Boolean)),
  fileScopes: uniqueSorted(input.filePaths.map(fileScope).filter(Boolean)),
});

const overlapRatio = (left: string[], right: string[]): number => {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const overlap = left.filter((value) => rightSet.has(value)).length;
  return overlap / Math.min(left.length, right.length);
};

export const scoreFingerprintMatch = (
  previous: ChangeFingerprint,
  candidate: ChangeFingerprint,
): number => {
  const areaOverlap = overlapRatio(previous.areaSlugs, candidate.areaSlugs);
  if (areaOverlap === 0) return 0;

  const termOverlap = overlapRatio(previous.terms, candidate.terms);
  const fileOverlap = overlapRatio(previous.fileScopes, candidate.fileScopes);
  const score = areaOverlap * 35 + termOverlap * 40 + fileOverlap * 25;
  return Math.round(score);
};

export const shouldAutoLink = (score: number): boolean => score >= 75;

export const suggestRelation = (
  input: Pick<ChangeFingerprintInput, "title" | "category">,
  hasPreviousEntry: boolean,
): SuggestedLineageRelation => {
  const normalizedTitle = normalizeText(input.title);
  if (
    /\b(remove|removed|delete|deleted|retire|retired|remover|removido)\b/u.test(
      normalizedTitle,
    )
  ) {
    return "removed";
  }
  if (
    /\b(restore|restored|re-enable|reenable|restaurar|restaurado)\b/u.test(
      normalizedTitle,
    )
  ) {
    return "restored";
  }
  if (input.category === "bugfix") return "fixed";
  if (!hasPreviousEntry) return "introduced";
  if (input.category === "feature" || input.category === "refactor") {
    return "modified";
  }
  return "other";
};

export const buildSuggestedLineageKey = (
  fingerprint: ChangeFingerprint,
): string | null => {
  const area = fingerprint.areaSlugs[0];
  const subject = fingerprint.terms.slice(0, 4);
  if (area === undefined || subject.length === 0) return null;
  return [area, ...subject].join("-");
};
