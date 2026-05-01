export interface CompareCommitLite {
  sha: string;
  message: string;
}

export interface StandaloneCommitHint {
  sha: string;
  messageLine: string;
}

const mergePrLineRe = /^Merge pull request #\d+/im;
const squashPrSuffixRe = /\(#\d+\)\s*$/m;

/** Commit whose message explicitly references a PR (merge ou squash típico). */
export const isCommitMessagePrReferenced = (message: string): boolean => {
  return mergePrLineRe.test(message) || squashPrSuffixRe.test(message);
};

const MAX_LINE = 240;

/**
 * Commits no intervalo que **não** parecem ser merge/squash de PR são candidatos a
 * “mudanças diretas” na branch — enviados ao LLM como texto cru (primeira linha).
 */
export const execute = (commits: CompareCommitLite[]): StandaloneCommitHint[] => {
  const out: StandaloneCommitHint[] = [];
  for (const c of commits) {
    const msg = c.message.trim();
    if (!msg.length) {
      continue;
    }
    if (isCommitMessagePrReferenced(msg)) {
      continue;
    }
    const first = msg.split("\n")[0]?.trim() ?? "";
    if (!first.length) {
      continue;
    }
    out.push({
      sha: c.sha,
      messageLine: first.length > MAX_LINE ? `${first.slice(0, MAX_LINE)}…` : first,
    });
  }
  return out;
};
