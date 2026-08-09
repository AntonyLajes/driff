import type { Database } from "@/db/client.js";
import {
  execute as readTimeline,
  type ExecuteInput as ReadTimelineInput,
} from "@/timeline/read-timeline.js";

const MAX_PAGES = 10;
const PAGE_SIZE = 20;
const MAX_MATCHES = 5;

const STOP_WORDS = new Set([
  "a",
  "as",
  "ao",
  "como",
  "da",
  "das",
  "de",
  "do",
  "dos",
  "em",
  "foi",
  "foram",
  "na",
  "nas",
  "no",
  "nos",
  "o",
  "os",
  "quando",
  "que",
  "quem",
  "the",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "version",
  "versao",
  "mudou",
  "mudanca",
  "mudancas",
  "changed",
  "change",
  "changes",
  "added",
  "adicionamos",
  "alteramos",
]);

const SYNONYMS: Record<string, string[]> = {
  acao: ["action"],
  acoes: ["actions"],
  botao: ["button"],
  botoes: ["buttons"],
  combustivel: ["fuel"],
  inicio: ["home"],
  parada: ["stop"],
  paradas: ["stops"],
  rapido: ["quick"],
  rapida: ["quick"],
  rapidas: ["quick"],
  tela: ["screen"],
};

type TimelineResult = Awaited<ReturnType<typeof readTimeline>>;
type TimelineVersion = TimelineResult["versions"][number];
type TimelineChange = TimelineVersion["changes"][number];

export interface ExecuteInput {
  db: Database;
  workspaceId: string;
  question: string;
  timelineReader?: (
    input: ReadTimelineInput,
  ) => Promise<TimelineResult>;
}

const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

const extractVersion = (question: string): string | null => {
  const match = question.match(
    /\bv?\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.-]+)?\b/i,
  );
  return match?.[0] === undefined
    ? null
    : normalize(match[0]).replace(/^v/, "");
};

const tokenize = (question: string): string[] => {
  const normalized = normalize(question);
  const raw = normalized.match(/[a-z0-9][a-z0-9._+-]*/g) ?? [];
  const terms = new Set<string>();
  for (const token of raw) {
    if (token.length < 2 || STOP_WORDS.has(token)) continue;
    terms.add(token);
    for (const synonym of SYNONYMS[token] ?? []) {
      terms.add(synonym);
    }
  }
  return [...terms];
};

const versionSummary = (version: TimelineVersion) => ({
  id: version.id,
  displayVersion: version.displayVersion,
  normalizedVersion: version.normalizedVersion,
  buildVersion: version.buildVersion,
  title: version.title,
  changelog: version.changelog,
  sourceUrl: version.sourceUrl,
  releasedAt: version.releasedAt,
});

const hasCitedEvidence = (change: TimelineChange): boolean =>
  change.evidence.some(
    (evidence) => evidence.url !== null && evidence.url.length > 0,
  );

const loadHistory = async (input: ExecuteInput) => {
  const reader = input.timelineReader ?? readTimeline;
  const versions: TimelineVersion[] = [];
  let inDevelopment: TimelineChange[] = [];
  let cursor: ReadTimelineInput["cursor"] = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await reader({
      db: input.db,
      workspaceId: input.workspaceId,
      limit: PAGE_SIZE,
      cursor,
    });
    versions.push(...result.versions);
    if (page === 0) {
      inDevelopment = result.inDevelopment?.changes ?? [];
    }
    if (!result.pageInfo.hasNextPage || result.pageInfo.nextCursor === null) {
      break;
    }
    cursor = result.pageInfo.nextCursor;
  }

  return { versions, inDevelopment };
};

const scoreChange = (change: TimelineChange, terms: string[]): number => {
  const fields = [
    { value: change.title, weight: 5 },
    { value: change.summaryExecutive ?? "", weight: 4 },
    { value: change.summaryTechnical ?? "", weight: 2 },
    { value: change.areas.map((area) => area.name).join(" "), weight: 4 },
    {
      value: change.contributors
        .map(
          (contributor) =>
            contributor.displayName ?? contributor.externalIdentity,
        )
        .join(" "),
      weight: 2,
    },
  ];
  return terms.reduce(
    (total, term) =>
      total +
      fields.reduce(
        (score, field) =>
          normalize(field.value).includes(term) ? score + field.weight : score,
        0,
      ),
    0,
  );
};

const noEvidence = (terms: string[]) => ({
  status: "no_evidence" as const,
  mode: "change" as const,
  confidence: "none" as const,
  queryTerms: terms,
  version: null,
  matches: [],
});

export const execute = async (input: ExecuteInput) => {
  const history = await loadHistory(input);
  const versionQuery = extractVersion(input.question);

  if (versionQuery !== null) {
    const version = history.versions.find((candidate) => {
      const display = normalize(candidate.displayVersion).replace(/^v/, "");
      const normalized = normalize(candidate.normalizedVersion).replace(
        /^v/,
        "",
      );
      return (
        display === versionQuery ||
        normalized === versionQuery ||
        normalized.startsWith(`${versionQuery}+`)
      );
    });
    if (version === undefined) {
      return noEvidence([versionQuery]);
    }

    const citedChanges = version.changes.filter(hasCitedEvidence);
    if (version.sourceUrl === null && citedChanges.length === 0) {
      return noEvidence([versionQuery]);
    }
    return {
      status: "answered" as const,
      mode: "version" as const,
      confidence: "high" as const,
      queryTerms: [versionQuery],
      version: versionSummary(version),
      matches: citedChanges.slice(0, MAX_MATCHES).map((change) => ({
        score: 100,
        change,
        version: versionSummary(version),
      })),
    };
  }

  const terms = tokenize(input.question);
  if (terms.length === 0) {
    return noEvidence(terms);
  }

  const candidates = [
    ...history.inDevelopment.map((change) => ({ change, version: null })),
    ...history.versions.flatMap((version) =>
      version.changes.map((change) => ({
        change,
        version: versionSummary(version),
      })),
    ),
  ];
  const matches = candidates
    .filter(({ change }) => hasCitedEvidence(change))
    .map((candidate) => ({
      ...candidate,
      score: scoreChange(candidate.change, terms),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.change.lastOccurredAt.localeCompare(left.change.lastOccurredAt),
    )
    .slice(0, MAX_MATCHES);

  if (matches.length === 0) {
    return noEvidence(terms);
  }
  const topScore = matches[0]?.score ?? 0;
  return {
    status: "answered" as const,
    mode: "change" as const,
    confidence:
      topScore >= 12
        ? ("high" as const)
        : topScore >= 6
          ? ("medium" as const)
          : ("low" as const),
    queryTerms: terms,
    version: null,
    matches,
  };
};
