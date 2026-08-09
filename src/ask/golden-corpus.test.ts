import { describe, expect, it } from "vitest";

import { execute } from "@/ask/golden-corpus.js";

const minimalCorpus = () => ({
  schemaVersion: 1,
  id: "minimal-ask-corpus",
  name: "Minimal Ask corpus",
  workspaceId: "workspace-1",
  history: { versions: [], inDevelopment: [] },
  questions: [
    {
      id: "unknown-feature",
      question: "Who changed checkout?",
      expected: { status: "no_evidence", mode: "change" },
    },
  ],
  thresholds: {
    passRate: 1,
    citationPrecision: 1,
    refusalAccuracy: 1,
  },
});

describe("ask/golden-corpus execute", () => {
  it("should parse a bounded corpus and apply expectation defaults", () => {
    const corpus = execute(minimalCorpus());

    expect(corpus.id).toBe("minimal-ask-corpus");
    expect(corpus.questions[0]?.expected).toEqual({
      status: "no_evidence",
      mode: "change",
      changeIds: [],
      evidenceUrls: [],
      contributors: [],
    });
  });

  it("should reject duplicate question identifiers", () => {
    const input = minimalCorpus();
    input.questions.push({ ...input.questions[0]! });

    expect(() => execute(input)).toThrow(/duplicate question id/u);
  });

  it("should reject thresholds outside the zero-to-one range", () => {
    const input = minimalCorpus();
    input.thresholds.passRate = 1.1;

    expect(() => execute(input)).toThrow();
  });
});
