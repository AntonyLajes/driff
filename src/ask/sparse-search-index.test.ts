import { describe, expect, it } from "vitest";

import {
  buildSearchChunks,
  cosineSimilarity,
  createSparseEmbedding,
  scoreSearchChunks,
} from "@/ask/sparse-search-index.js";

const document = () =>
  buildSearchChunks({
    title: "Improve button feedback",
    summaryExecutive: "Makes the quick action easier to tap.",
    summaryTechnical: "Adds an Android ripple.",
    category: "feature",
    areas: ["home"],
    contributors: ["AntonyLajes"],
    evidence: ["16 src/screens/Home.tsx"],
  });

describe("ask/sparse-search-index", () => {
  it("creates normalized sparse embeddings", () => {
    const embedding = createSparseEmbedding("Botão botão");

    expect(embedding["word:botao"]).toBeGreaterThan(0);
    expect(embedding["gram:bot"]).toBeGreaterThan(0);
    const magnitude = Math.sqrt(
      Object.values(embedding).reduce((sum, value) => sum + value * value, 0),
    );
    expect(magnitude).toBeCloseTo(1);
    expect(createSparseEmbedding("   ")).toEqual({});
  });

  it("measures symmetry and keeps unrelated text separate", () => {
    const button = createSparseEmbedding("button");
    const typo = createSparseEmbedding("buton");
    const payment = createSparseEmbedding("payment");

    expect(cosineSimilarity(button, typo)).toBeCloseTo(
      cosineSimilarity(typo, button),
    );
    expect(cosineSimilarity(button, typo)).toBeGreaterThan(0.5);
    expect(cosineSimilarity(button, payment)).toBeLessThan(0.2);
  });

  it("keeps exact field weights and recovers a small typo", () => {
    const chunks = document();

    expect(scoreSearchChunks(chunks, ["AntonyLajes"])).toBe(8);
    expect(scoreSearchChunks(chunks, ["button"])).toBeGreaterThanOrEqual(5);
    expect(scoreSearchChunks(chunks, ["buton"])).toBeGreaterThan(0);
    expect(scoreSearchChunks(chunks, ["checkout"])).toBe(0);
  });

  it("does not promote weak trigram overlap from a highly weighted field", () => {
    const fuelDocument = buildSearchChunks({
      title: "Estimate fuel stops on ride cards",
      summaryExecutive: "Helps riders plan longer routes.",
      summaryTechnical: "Adds route logistics metadata.",
      category: "feature",
      areas: ["rides"],
      contributors: ["AntonyLajes"],
      evidence: ["pull request 15"],
    });

    expect(scoreSearchChunks(fuelDocument, ["buton"])).toBe(0);
  });

  it("matches a typo against an inflected document term", () => {
    const plural = buildSearchChunks({
      title: "Improve touch feedback on Home quick action buttons",
      summaryExecutive: null,
      summaryTechnical: null,
      category: "feature",
      areas: ["home"],
      contributors: ["AntonyLajes"],
      evidence: ["pull request 16"],
    });

    expect(scoreSearchChunks(plural, ["buton"])).toBeGreaterThan(0);
  });

  it("omits empty optional chunks", () => {
    const chunks = buildSearchChunks({
      title: "Release",
      summaryExecutive: null,
      summaryTechnical: null,
      category: "chore",
      areas: [],
      contributors: [],
      evidence: [],
    });

    expect(chunks.map((chunk) => chunk.kind)).toEqual(["title", "category"]);
  });
});
