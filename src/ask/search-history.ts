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
  "and",
  "ao",
  "are",
  "by",
  "como",
  "da",
  "das",
  "de",
  "did",
  "do",
  "dos",
  "em",
  "entregou",
  "entregaram",
  "esta",
  "este",
  "feita",
  "feitas",
  "feito",
  "feitos",
  "fez",
  "for",
  "foi",
  "foram",
  "from",
  "has",
  "in",
  "is",
  "na",
  "nas",
  "no",
  "nos",
  "o",
  "of",
  "on",
  "os",
  "para",
  "por",
  "qual",
  "quando",
  "que",
  "quem",
  "the",
  "to",
  "um",
  "uma",
  "was",
  "were",
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
  "implemented",
  "implementou",
  "last",
  "past",
  "shipped",
  "semana",
  "semanas",
  "this",
  "trabalhou",
  "ultima",
  "ultimas",
  "ultimo",
  "ultimos",
  "week",
  "weeks",
  "dia",
  "dias",
  "day",
  "days",
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
  inicial: ["home"],
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
type ChangeCandidate = {
  change: TimelineChange;
  version: ReturnType<typeof versionSummary> | null;
};

export interface ExecuteInput {
  db: Database;
  workspaceId: string;
  question: string;
  now?: Date;
  timelineReader?: (input: ReadTimelineInput) => Promise<TimelineResult>;
}

type QueryPeriod = {
  kind: "this_week" | "last_days";
  startAt: string;
  endAt: string;
  days: number | null;
};

const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

const extractVersion = (question: string): string | null => {
  const match = question.match(/\bv?\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.-]+)?\b/i);
  return match?.[0] === undefined
    ? null
    : normalize(match[0]).replace(/^v/, "");
};

const extractTemporalIntent = (
  question: string,
): { order: "earliest" | "latest" | null; category: string | null } => {
  const normalized = normalize(question);
  const latest =
    /\b(?:ultima|ultimo|latest|newest)\b/u.test(normalized) ||
    /\b(?:mais|most)\s+recente\b/u.test(normalized);
  const earliest = /\b(?:primeira|primeiro|first|oldest|earliest)\b/u.test(
    normalized,
  );
  const order = latest ? "latest" : earliest ? "earliest" : null;
  if (order === null) return { order, category: null };

  const categories: Array<{ category: string; pattern: RegExp }> = [
    {
      category: "feature",
      pattern: /\b(?:feature|features|funcionalidade|funcionalidades)\b/u,
    },
    {
      category: "bugfix",
      pattern: /\b(?:bug|bugfix|correcao|correcoes|fix)\b/u,
    },
    {
      category: "refactor",
      pattern: /\b(?:refactor|refatoracao|refatoracoes)\b/u,
    },
    {
      category: "chore",
      pattern: /\b(?:chore|maintenance|manutencao)\b/u,
    },
  ];
  return {
    order,
    category:
      categories.find(({ pattern }) => pattern.test(normalized))?.category ??
      null,
  };
};

const extractPeriod = (question: string, now: Date): QueryPeriod | null => {
  const normalized = normalize(question);
  const lastDays = normalized.match(
    /\b(?:ultimos|ultimas|last|past)\s+(\d{1,3})\s+(?:dias|days)\b/u,
  );
  if (lastDays?.[1] !== undefined) {
    const days = Number.parseInt(lastDays[1], 10);
    if (days >= 1 && days <= 365) {
      return {
        kind: "last_days",
        startAt: new Date(now.getTime() - days * 86_400_000).toISOString(),
        endAt: now.toISOString(),
        days,
      };
    }
  }

  if (/\b(?:esta semana|this week)\b/u.test(normalized)) {
    const start = new Date(now);
    const day = start.getUTCDay();
    const daysSinceMonday = day === 0 ? 6 : day - 1;
    start.setUTCDate(start.getUTCDate() - daysSinceMonday);
    start.setUTCHours(0, 0, 0, 0);
    return {
      kind: "this_week",
      startAt: start.toISOString(),
      endAt: now.toISOString(),
      days: null,
    };
  }

  return null;
};

const hasTeamOverviewIntent = (question: string): boolean =>
  /\b(?:time|equipe|team|everyone|todos|todas)\b/u.test(normalize(question)) ||
  /\bcada\s+(?:pessoa|dev|desenvolvedor|desenvolvedora)\b/u.test(
    normalize(question),
  );

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
    { value: change.category, weight: 4 },
    { value: change.areas.map((area) => area.name).join(" "), weight: 4 },
    {
      value: change.contributors
        .map(
          (contributor) =>
            contributor.displayName ?? contributor.externalIdentity,
        )
        .join(" "),
      weight: 8,
    },
    {
      value: change.evidence
        .map(
          (item) =>
            `${item.externalId ?? ""} ${item.path ?? ""} ${item.sourceKey}`,
        )
        .join(" "),
      weight: 5,
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

const noEvidence = (terms: string[], period: QueryPeriod | null = null) => ({
  status: "no_evidence" as const,
  mode: "change" as const,
  confidence: "none" as const,
  queryTerms: terms,
  period,
  totalMatches: 0,
  hasMore: false,
  version: null,
  matches: [],
});

const temporalMatch = (
  candidates: ChangeCandidate[],
  category: string | null,
  order: "earliest" | "latest",
) =>
  candidates
    .filter(
      ({ change }) =>
        hasCitedEvidence(change) &&
        (category === null || change.category === category),
    )
    .sort((left, right) => {
      const comparison = left.change.lastOccurredAt.localeCompare(
        right.change.lastOccurredAt,
      );
      return order === "earliest" ? comparison : -comparison;
    })[0];

const isInPeriod = (
  change: TimelineChange,
  period: QueryPeriod | null,
): boolean =>
  period === null ||
  (change.lastOccurredAt >= period.startAt &&
    change.lastOccurredAt <= period.endAt);

const confidenceForScore = (score: number) =>
  score >= 12
    ? ("high" as const)
    : score >= 6
      ? ("medium" as const)
      : ("low" as const);

const removeScopeTerms = (
  terms: string[],
  versionQuery: string | null,
  period: QueryPeriod | null,
): string[] =>
  terms.filter(
    (term) =>
      term !== versionQuery &&
      (period === null || period.days === null || term !== String(period.days)),
  );

export const execute = async (input: ExecuteInput) => {
  const history = await loadHistory(input);
  const versionQuery = extractVersion(input.question);
  const period = extractPeriod(input.question, input.now ?? new Date());
  const queryTerms = removeScopeTerms(
    tokenize(input.question),
    versionQuery,
    period,
  );
  const teamOverview = hasTeamOverviewIntent(input.question);

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
      return noEvidence([versionQuery, ...queryTerms], period);
    }

    const citedChanges = version.changes.filter(hasCitedEvidence);
    if (version.sourceUrl === null && citedChanges.length === 0) {
      return noEvidence([versionQuery, ...queryTerms], period);
    }
    const rankedChanges =
      queryTerms.length === 0 || teamOverview
        ? citedChanges.map((change) => ({ change, score: 100 }))
        : citedChanges
            .map((change) => ({
              change,
              score: scoreChange(change, queryTerms),
            }))
            .filter(({ score }) => score > 0)
            .sort(
              (left, right) =>
                right.score - left.score ||
                right.change.lastOccurredAt.localeCompare(
                  left.change.lastOccurredAt,
                ),
            );
    if (queryTerms.length > 0 && !teamOverview && rankedChanges.length === 0) {
      return noEvidence([versionQuery, ...queryTerms], period);
    }
    const topScore = rankedChanges[0]?.score ?? 100;
    return {
      status: "answered" as const,
      mode: "version" as const,
      confidence:
        queryTerms.length === 0 || teamOverview
          ? ("high" as const)
          : confidenceForScore(topScore),
      queryTerms: [versionQuery, ...queryTerms],
      period,
      totalMatches: rankedChanges.length,
      hasMore: rankedChanges.length > MAX_MATCHES,
      version: versionSummary(version),
      matches: rankedChanges.slice(0, MAX_MATCHES).map(({ change, score }) => ({
        score,
        change,
        version: versionSummary(version),
      })),
    };
  }

  const candidates: ChangeCandidate[] = [
    ...history.inDevelopment.map((change) => ({ change, version: null })),
    ...history.versions.flatMap((version) =>
      version.changes.map((change) => ({
        change,
        version: versionSummary(version),
      })),
    ),
  ].filter(
    ({ change }) => hasCitedEvidence(change) && isInPeriod(change, period),
  );
  const temporalIntent = extractTemporalIntent(input.question);
  if (temporalIntent.order !== null) {
    const match = temporalMatch(
      candidates,
      temporalIntent.category,
      temporalIntent.order,
    );
    if (match === undefined) return noEvidence(queryTerms, period);
    return {
      status: "answered" as const,
      mode: "change" as const,
      confidence: "high" as const,
      queryTerms,
      period,
      totalMatches: 1,
      hasMore: false,
      version: null,
      matches: [{ ...match, score: 100 }],
    };
  }

  if (teamOverview || (period !== null && queryTerms.length === 0)) {
    const rankedCandidates = candidates.sort((left, right) =>
      right.change.lastOccurredAt.localeCompare(left.change.lastOccurredAt),
    );
    if (rankedCandidates.length === 0) return noEvidence(queryTerms, period);
    return {
      status: "answered" as const,
      mode: "change" as const,
      confidence: "high" as const,
      queryTerms,
      period,
      totalMatches: rankedCandidates.length,
      hasMore: rankedCandidates.length > MAX_MATCHES,
      version: null,
      matches: rankedCandidates
        .slice(0, MAX_MATCHES)
        .map((candidate) => ({ ...candidate, score: 100 })),
    };
  }

  if (queryTerms.length === 0) {
    return noEvidence(queryTerms, period);
  }

  const rankedMatches = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreChange(candidate.change, queryTerms),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.change.lastOccurredAt.localeCompare(left.change.lastOccurredAt),
    );

  if (rankedMatches.length === 0) {
    return noEvidence(queryTerms, period);
  }
  const topScore = rankedMatches[0]?.score ?? 0;
  return {
    status: "answered" as const,
    mode: "change" as const,
    confidence: confidenceForScore(topScore),
    queryTerms,
    period,
    totalMatches: rankedMatches.length,
    hasMore: rankedMatches.length > MAX_MATCHES,
    version: null,
    matches: rankedMatches.slice(0, MAX_MATCHES),
  };
};
