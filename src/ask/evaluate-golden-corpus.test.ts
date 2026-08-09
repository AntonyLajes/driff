import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { execute } from "@/ask/evaluate-golden-corpus.js";
import { execute as evaluateSuite } from "@/ask/evaluate-golden-suite.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/ride-pack-golden.json", import.meta.url),
);
const fixtureDirectory = dirname(fixturePath);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ask/evaluate-golden-corpus execute", () => {
  it("should pass the Ride Pack cited-history baseline", async () => {
    const evaluation = await execute({ filePath: fixturePath });

    expect(evaluation).toEqual(
      expect.objectContaining({
        corpusId: "ride-pack-cited-history",
        totalCases: 13,
        passedCases: 13,
        passRate: 1,
        citationPrecision: 1,
        refusalAccuracy: 1,
        thresholdPassed: true,
      }),
    );
    expect(evaluation.cases.every((item) => item.passed)).toBe(true);
    expect(evaluation.durationMs).toBeGreaterThanOrEqual(0);
    expect(evaluation.meanCaseDurationMs).toBeGreaterThanOrEqual(0);
    expect(evaluation.p95CaseDurationMs).toBeGreaterThanOrEqual(0);
    expect(evaluation.runtimeUsage).toEqual({
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(
      evaluation.cases.every((item) => item.durationMs >= 0),
    ).toBe(true);
  });

  it("should report the precise missing expectation and fail the threshold", async () => {
    const directory = await mkdtemp(join(tmpdir(), "driff-ask-corpus-"));
    temporaryDirectories.push(directory);
    const raw = await readFile(fixturePath, "utf8");
    const fixture = JSON.parse(raw) as {
      questions: Array<{
        id: string;
        expected: {
          status: string;
          mode?: string;
          version?: string;
          changeIds?: string[];
          evidenceUrls: string[];
          contributors: string[];
        };
      }>;
    };
    const target = fixture.questions.find(
      (question) => question.id === "home-actions-en",
    );
    if (target === undefined) throw new Error("Expected golden question.");
    target.expected.status = "no_evidence";
    target.expected.mode = "version";
    target.expected.version = "99.0.0";
    target.expected.changeIds = ["change-that-does-not-exist"];
    target.expected.evidenceUrls = ["https://example.com/missing-evidence"];
    target.expected.contributors = ["missing-contributor"];
    const failingPath = join(directory, "failing-corpus.json");
    await writeFile(failingPath, JSON.stringify(fixture), "utf8");

    const evaluation = await execute({ filePath: failingPath });

    expect(evaluation.thresholdPassed).toBe(false);
    expect(evaluation.passedCases).toBe(12);
    expect(
      evaluation.cases.find((item) => item.id === "home-actions-en"),
    ).toEqual(
      expect.objectContaining({
        passed: false,
        failures: expect.arrayContaining([
          "expected status no_evidence, received answered",
          "expected mode version, received change",
          "expected version 99.0.0, received none",
          "missing expected change change-that-does-not-exist",
          "missing expected evidence https://example.com/missing-evidence",
          "missing expected contributor missing-contributor",
        ]),
      }),
    );
  });

  it("should fail before evaluation when the corpus is malformed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "driff-ask-corpus-"));
    temporaryDirectories.push(directory);
    const invalidPath = join(directory, "invalid-corpus.json");
    await writeFile(invalidPath, JSON.stringify({ schemaVersion: 2 }), "utf8");

    await expect(execute({ filePath: invalidPath })).rejects.toThrow();
  });
});

describe("ask/evaluate-golden-suite execute", () => {
  it("should pass the mobile, web and backend cited-history corpora", async () => {
    const evaluation = await evaluateSuite({
      directoryPath: fixtureDirectory,
    });

    expect(evaluation).toEqual(
      expect.objectContaining({
        totalCorpora: 3,
        totalCases: 31,
        passedCases: 31,
        thresholdPassed: true,
      }),
    );
    expect(evaluation.corpora.map((corpus) => corpus.corpusId)).toEqual([
      "backend-api-cited-history",
      "ride-pack-cited-history",
      "web-commerce-cited-history",
    ]);
    expect(evaluation.durationMs).toBeGreaterThanOrEqual(0);
    expect(evaluation.meanCaseDurationMs).toBeGreaterThanOrEqual(0);
    expect(evaluation.p95CaseDurationMs).toBeGreaterThanOrEqual(0);
    expect(evaluation.runtimeUsage).toEqual({
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});
