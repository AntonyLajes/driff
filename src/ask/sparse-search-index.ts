export type SearchChunkKind =
  | "title"
  | "executive_summary"
  | "technical_summary"
  | "category"
  | "areas"
  | "contributors"
  | "evidence";

export type SparseEmbedding = Record<string, number>;

export type SearchChunk = {
  kind: SearchChunkKind;
  text: string;
  weight: number;
  embedding: SparseEmbedding;
};

export type SearchDocumentInput = {
  title: string;
  summaryExecutive: string | null;
  summaryTechnical: string | null;
  category: string;
  areas: string[];
  contributors: string[];
  evidence: string[];
};

const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

const dimensionsFor = (value: string): string[] => {
  const words = normalize(value).match(/[a-z0-9][a-z0-9._+-]*/g) ?? [];
  const dimensions: string[] = [];
  for (const word of words) {
    dimensions.push(`word:${word}`);
    if (word.length < 3) continue;
    const padded = `^${word}$`;
    for (let index = 0; index <= padded.length - 3; index += 1) {
      dimensions.push(`gram:${padded.slice(index, index + 3)}`);
    }
  }
  return dimensions;
};

/**
 * Provider-independent sparse embedding used as the V1 semantic baseline.
 * Word dimensions retain exact intent while character trigrams tolerate small
 * typos without sending source text to another provider.
 */
export const createSparseEmbedding = (value: string): SparseEmbedding => {
  const counts = new Map<string, number>();
  for (const dimension of dimensionsFor(value)) {
    counts.set(dimension, (counts.get(dimension) ?? 0) + 1);
  }
  const magnitude = Math.sqrt(
    [...counts.values()].reduce((total, count) => total + count * count, 0),
  );
  if (magnitude === 0) return {};
  return Object.fromEntries(
    [...counts.entries()].map(([dimension, count]) => [
      dimension,
      count / magnitude,
    ]),
  );
};

export const cosineSimilarity = (
  left: SparseEmbedding,
  right: SparseEmbedding,
): number => {
  const [smallest, largest] =
    Object.keys(left).length <= Object.keys(right).length
      ? [left, right]
      : [right, left];
  return Object.entries(smallest).reduce(
    (score, [dimension, value]) =>
      score + value * (largest[dimension] ?? 0),
    0,
  );
};

const CHUNK_FIELDS: Array<{
  kind: SearchChunkKind;
  weight: number;
  read: (input: SearchDocumentInput) => string;
}> = [
  { kind: "title", weight: 5, read: (input) => input.title },
  {
    kind: "executive_summary",
    weight: 4,
    read: (input) => input.summaryExecutive ?? "",
  },
  {
    kind: "technical_summary",
    weight: 2,
    read: (input) => input.summaryTechnical ?? "",
  },
  { kind: "category", weight: 4, read: (input) => input.category },
  { kind: "areas", weight: 4, read: (input) => input.areas.join(" ") },
  {
    kind: "contributors",
    weight: 8,
    read: (input) => input.contributors.join(" "),
  },
  { kind: "evidence", weight: 5, read: (input) => input.evidence.join(" ") },
];

export const buildSearchChunks = (input: SearchDocumentInput): SearchChunk[] =>
  CHUNK_FIELDS.map(({ kind, weight, read }) => {
    const text = read(input).trim();
    return { kind, weight, text, embedding: createSparseEmbedding(text) };
  }).filter((chunk) => chunk.text.length > 0);

const MIN_SEMANTIC_SIMILARITY = 0.52;

/** Hybrid exact + sparse-semantic rank. Exact matches preserve the established
 * V1 ranking; the embedding contributes only when a term was not found exactly. */
export const scoreSearchChunks = (
  chunks: SearchChunk[],
  terms: string[],
): number =>
  terms.reduce((total, term) => {
    const normalizedTerm = normalize(term);
    if (normalizedTerm.length === 0) return total;
    const exact = chunks.reduce(
      (score, chunk) =>
        normalize(chunk.text).includes(normalizedTerm)
          ? score + chunk.weight
          : score,
      0,
    );
    if (exact > 0) return total + exact;

    const queryEmbedding = createSparseEmbedding(normalizedTerm);
    const semantic = chunks.reduce((best, chunk) => {
      const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
      return Math.max(best, similarity * chunk.weight);
    }, 0);
    return total + (semantic >= MIN_SEMANTIC_SIMILARITY ? semantic : 0);
  }, 0);
