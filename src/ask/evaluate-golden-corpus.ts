import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Database } from "@/db/client.js";
import { execute as parseCorpus } from "@/ask/golden-corpus.js";
import { execute as searchHistory } from "@/ask/search-history.js";

export interface ExecuteInput {
  filePath: string;
}

export interface GoldenCaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  returnedMatches: number;
  citedMatches: number;
}

export interface GoldenEvaluation {
  corpusId: string;
  totalCases: number;
  passedCases: number;
  passRate: number;
  citationPrecision: number;
  refusalAccuracy: number;
  thresholdPassed: boolean;
  cases: GoldenCaseResult[];
}

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 1 : numerator / denominator;

export const execute = async ({
  filePath,
}: ExecuteInput): Promise<GoldenEvaluation> => {
  const raw = await readFile(resolve(filePath), "utf8");
  const corpus = parseCorpus(JSON.parse(raw) as unknown);
  const timeline = {
    versions: corpus.history.versions,
    inDevelopment: {
      changes: corpus.history.inDevelopment,
      hasMore: false,
    },
    pageInfo: { hasNextPage: false, nextCursor: null },
  };

  const cases: GoldenCaseResult[] = [];
  let returnedMatches = 0;
  let citedMatches = 0;
  let expectedRefusals = 0;
  let correctRefusals = 0;

  for (const goldenCase of corpus.questions) {
    const result = await searchHistory({
      db: {} as Database,
      workspaceId: corpus.workspaceId,
      question: goldenCase.question,
      timelineReader: async () => timeline,
    });
    const failures: string[] = [];
    const actualChangeIds = new Set(
      result.matches.map((match) => match.change.id),
    );
    const actualEvidenceUrls = new Set(
      result.matches.flatMap((match) =>
        match.change.evidence.flatMap((evidence) =>
          evidence.url === null ? [] : [evidence.url],
        ),
      ),
    );
    const actualContributors = new Set(
      result.matches.flatMap((match) =>
        match.change.contributors.flatMap((contributor) => [
          contributor.externalIdentity,
          ...(contributor.displayName === null
            ? []
            : [contributor.displayName]),
        ]),
      ),
    );

    if (result.status !== goldenCase.expected.status) {
      failures.push(
        `expected status ${goldenCase.expected.status}, received ${result.status}`,
      );
    }
    if (
      goldenCase.expected.mode !== undefined &&
      result.mode !== goldenCase.expected.mode
    ) {
      failures.push(
        `expected mode ${goldenCase.expected.mode}, received ${result.mode}`,
      );
    }
    if (
      goldenCase.expected.version !== undefined &&
      result.version?.displayVersion !== goldenCase.expected.version
    ) {
      failures.push(
        `expected version ${goldenCase.expected.version}, received ${result.version?.displayVersion ?? "none"}`,
      );
    }
    for (const changeId of goldenCase.expected.changeIds) {
      if (!actualChangeIds.has(changeId)) {
        failures.push(`missing expected change ${changeId}`);
      }
    }
    for (const evidenceUrl of goldenCase.expected.evidenceUrls) {
      if (!actualEvidenceUrls.has(evidenceUrl)) {
        failures.push(`missing expected evidence ${evidenceUrl}`);
      }
    }
    for (const contributor of goldenCase.expected.contributors) {
      if (!actualContributors.has(contributor)) {
        failures.push(`missing expected contributor ${contributor}`);
      }
    }

    const caseCitedMatches = result.matches.filter((match) =>
      match.change.evidence.some((evidence) => evidence.url !== null),
    ).length;
    returnedMatches += result.matches.length;
    citedMatches += caseCitedMatches;
    if (goldenCase.expected.status === "no_evidence") {
      expectedRefusals += 1;
      if (result.status === "no_evidence") correctRefusals += 1;
    }
    cases.push({
      id: goldenCase.id,
      passed: failures.length === 0,
      failures,
      returnedMatches: result.matches.length,
      citedMatches: caseCitedMatches,
    });
  }

  const passedCases = cases.filter((item) => item.passed).length;
  const passRate = ratio(passedCases, cases.length);
  const citationPrecision = ratio(citedMatches, returnedMatches);
  const refusalAccuracy = ratio(correctRefusals, expectedRefusals);
  const thresholdPassed =
    passRate >= corpus.thresholds.passRate &&
    citationPrecision >= corpus.thresholds.citationPrecision &&
    refusalAccuracy >= corpus.thresholds.refusalAccuracy;

  return {
    corpusId: corpus.id,
    totalCases: cases.length,
    passedCases,
    passRate,
    citationPrecision,
    refusalAccuracy,
    thresholdPassed,
    cases,
  };
};

const percentage = (value: number): string => `${(value * 100).toFixed(1)}%`;

const runCli = async (): Promise<void> => {
  const filePath = process.argv[2];
  if (filePath === undefined) {
    throw new Error("Usage: npm run ask:evaluate -- <golden-corpus.json>");
  }
  const evaluation = await execute({ filePath });
  process.stdout.write(
    [
      `Ask corpus ${evaluation.corpusId}: ${evaluation.passedCases}/${evaluation.totalCases} cases passed.`,
      `Pass rate: ${percentage(evaluation.passRate)}.`,
      `Citation precision: ${percentage(evaluation.citationPrecision)}.`,
      `Refusal accuracy: ${percentage(evaluation.refusalAccuracy)}.`,
      `Threshold: ${evaluation.thresholdPassed ? "PASS" : "FAIL"}.`,
    ].join(" ") + "\n",
  );
  for (const item of evaluation.cases.filter((item) => !item.passed)) {
    process.stderr.write(`- ${item.id}: ${item.failures.join("; ")}\n`);
  }
  if (!evaluation.thresholdPassed) process.exitCode = 1;
};

const entrypointUrl =
  process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entrypointUrl === import.meta.url) {
  runCli().catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown Ask Driff corpus evaluation error.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
