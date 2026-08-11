import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { execute } from "@/ask/evaluate-golden-corpus.js";
import { execute as evaluateSuite } from "@/ask/evaluate-golden-suite.js";
import {
  compareSnapshots,
  createSnapshot,
  goldenSuiteSnapshotSchema,
  readSnapshot,
  writeSnapshot,
} from "@/ask/golden-baseline.js";

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
    expect(evaluation.cases.every((item) => item.durationMs >= 0)).toBe(true);
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

  it("should compare the current suite with an approved stable baseline", async () => {
    const evaluation = await evaluateSuite({
      directoryPath: fixtureDirectory,
    });
    const baseline = createSnapshot(evaluation, "ask-retrieval-v1");
    const current = createSnapshot(evaluation, "candidate-sha");

    expect(compareSnapshots({ baseline, current })).toEqual({
      baselineRevision: "ask-retrieval-v1",
      currentRevision: "candidate-sha",
      passed: true,
      regressions: [],
      improvements: [],
      additions: [],
    });
    expect(baseline).not.toHaveProperty("durationMs");
    expect(baseline.corpora[0]).not.toHaveProperty("meanCaseDurationMs");
  });

  it("should fail comparison when approved coverage or quality regresses", async () => {
    const evaluation = await evaluateSuite({
      directoryPath: fixtureDirectory,
    });
    const baseline = createSnapshot(evaluation, "approved");
    const current = structuredClone(baseline);
    current.revision = "candidate";
    const corpus = current.corpora[0];
    if (corpus === undefined) throw new Error("Expected baseline corpus.");
    corpus.citationPrecision = 0.8;
    const goldenCase = corpus.cases[0];
    if (goldenCase === undefined) throw new Error("Expected baseline case.");
    goldenCase.passed = false;
    corpus.passedCases -= 1;
    current.passedCases -= 1;
    const removedCase = corpus.cases.splice(1, 1)[0];
    if (removedCase === undefined) throw new Error("Expected removable case.");
    corpus.totalCases -= 1;
    current.totalCases -= 1;
    if (removedCase.passed) {
      corpus.passedCases -= 1;
      current.passedCases -= 1;
    }
    corpus.passRate = corpus.passedCases / corpus.totalCases;
    const removedCorpus = current.corpora.splice(1, 1)[0];
    if (removedCorpus === undefined)
      throw new Error("Expected removable corpus.");
    current.totalCorpora -= 1;
    current.totalCases -= removedCorpus.totalCases;
    current.passedCases -= removedCorpus.passedCases;

    const comparison = compareSnapshots({ baseline, current });

    expect(comparison.passed).toBe(false);
    expect(comparison.regressions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pass rate decreased"),
        expect.stringContaining("citation precision decreased"),
        expect.stringContaining("changed from pass to fail"),
        expect.stringContaining("was removed"),
        expect.stringContaining("corpus ride-pack-cited-history was removed"),
      ]),
    );
  });

  it("should persist and validate an explicitly approved baseline", async () => {
    const evaluation = await evaluateSuite({
      directoryPath: fixtureDirectory,
    });
    const snapshot = createSnapshot(evaluation, "approved-revision");
    const directory = await mkdtemp(join(tmpdir(), "driff-ask-baseline-"));
    temporaryDirectories.push(directory);
    const baselinePath = join(directory, "baseline.json");

    await writeSnapshot(baselinePath, snapshot);

    expect(await readSnapshot(baselinePath)).toEqual(snapshot);
    expect(
      goldenSuiteSnapshotSchema.parse(
        JSON.parse(await readFile(baselinePath, "utf8")) as unknown,
      ),
    ).toEqual(snapshot);
  });

  it("should reject a baseline whose totals do not match its case records", async () => {
    const evaluation = await evaluateSuite({
      directoryPath: fixtureDirectory,
    });
    const snapshot = createSnapshot(evaluation, "invalid-revision");
    snapshot.corpora[0]!.totalCases += 1;

    expect(() => goldenSuiteSnapshotSchema.parse(snapshot)).toThrow();
  });
});
