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
  });

  it("should report the precise missing expectation and fail the threshold", async () => {
    const directory = await mkdtemp(join(tmpdir(), "driff-ask-corpus-"));
    temporaryDirectories.push(directory);
    const raw = await readFile(fixturePath, "utf8");
    const fixture = JSON.parse(raw) as {
      questions: Array<{
        id: string;
        expected: { changeIds?: string[] };
      }>;
    };
    const target = fixture.questions.find(
      (question) => question.id === "home-actions-en",
    );
    if (target === undefined) throw new Error("Expected golden question.");
    target.expected.changeIds = ["change-that-does-not-exist"];
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
        failures: ["missing expected change change-that-does-not-exist"],
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
  });
});
