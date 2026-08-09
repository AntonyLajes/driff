import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  execute as evaluateCorpus,
  type GoldenEvaluation,
} from "@/ask/evaluate-golden-corpus.js";
import {
  compareSnapshots,
  createSnapshot,
  readSnapshot,
  writeSnapshot,
} from "@/ask/golden-baseline.js";

export interface ExecuteInput {
  directoryPath: string;
}

export interface GoldenSuiteEvaluation {
  totalCorpora: number;
  totalCases: number;
  passedCases: number;
  thresholdPassed: boolean;
  durationMs: number;
  meanCaseDurationMs: number;
  p95CaseDurationMs: number;
  runtimeUsage: {
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
  corpora: GoldenEvaluation[];
}

export const execute = async ({
  directoryPath,
}: ExecuteInput): Promise<GoldenSuiteEvaluation> => {
  const suiteStartedAt = performance.now();
  const directory = resolve(directoryPath);
  const fixtureNames = (await readdir(directory))
    .filter((name) => name.endsWith("-golden.json"))
    .sort();
  if (fixtureNames.length === 0) {
    throw new Error(`No golden corpus files found in ${directory}.`);
  }

  const corpora = await Promise.all(
    fixtureNames.map((name) =>
      evaluateCorpus({ filePath: join(directory, name) }),
    ),
  );
  const caseDurations = corpora.flatMap((corpus) =>
    corpus.cases.map((item) => item.durationMs),
  );
  const sortedDurations = [...caseDurations].sort(
    (left, right) => left - right,
  );
  const p95Index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1);
  return {
    totalCorpora: corpora.length,
    totalCases: corpora.reduce((total, corpus) => total + corpus.totalCases, 0),
    passedCases: corpora.reduce(
      (total, corpus) => total + corpus.passedCases,
      0,
    ),
    thresholdPassed: corpora.every((corpus) => corpus.thresholdPassed),
    durationMs: Math.round((performance.now() - suiteStartedAt) * 1000) / 1000,
    meanCaseDurationMs:
      Math.round(
        (caseDurations.reduce((total, duration) => total + duration, 0) /
          Math.max(1, caseDurations.length)) *
          1000,
      ) / 1000,
    p95CaseDurationMs:
      Math.round((sortedDurations[p95Index] ?? 0) * 1000) / 1000,
    runtimeUsage: corpora.reduce(
      (usage, corpus) => ({
        llmCalls: usage.llmCalls + corpus.runtimeUsage.llmCalls,
        inputTokens: usage.inputTokens + corpus.runtimeUsage.inputTokens,
        outputTokens: usage.outputTokens + corpus.runtimeUsage.outputTokens,
      }),
      { llmCalls: 0, inputTokens: 0, outputTokens: 0 },
    ),
    corpora,
  };
};

const percentage = (value: number): string => `${(value * 100).toFixed(1)}%`;

const runCli = async (): Promise<void> => {
  const defaultDirectory = dirname(
    fileURLToPath(new URL("./fixtures/ride-pack-golden.json", import.meta.url)),
  );
  const args = process.argv.slice(2);
  const directoryPath = args.find((arg) => !arg.startsWith("--"));
  const option = (name: string): string | undefined =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const defaultBaselinePath = fileURLToPath(
    new URL("./fixtures/ask-golden-baseline.json", import.meta.url),
  );
  const requestedRevision = option("revision");
  const revision =
    requestedRevision ??
    process.env.ASK_EVALUATOR_REVISION ??
    process.env.GITHUB_SHA ??
    "working-tree";
  const evaluation = await execute({
    directoryPath: directoryPath ?? defaultDirectory,
  });
  const snapshot = createSnapshot(evaluation, revision);
  process.stdout.write(
    `Ask suite: ${evaluation.passedCases}/${evaluation.totalCases} cases passed across ${evaluation.totalCorpora} corpora. Threshold: ${evaluation.thresholdPassed ? "PASS" : "FAIL"}. Latency: mean ${evaluation.meanCaseDurationMs.toFixed(3)}ms, p95 ${evaluation.p95CaseDurationMs.toFixed(3)}ms. Runtime LLM usage: ${evaluation.runtimeUsage.llmCalls} calls, ${evaluation.runtimeUsage.inputTokens + evaluation.runtimeUsage.outputTokens} tokens.\n`,
  );
  for (const corpus of evaluation.corpora) {
    process.stdout.write(
      `- ${corpus.corpusId}: ${corpus.passedCases}/${corpus.totalCases}, citations ${percentage(corpus.citationPrecision)}, refusals ${percentage(corpus.refusalAccuracy)}, latency mean ${corpus.meanCaseDurationMs.toFixed(3)}ms / p95 ${corpus.p95CaseDurationMs.toFixed(3)}ms.\n`,
    );
    for (const item of corpus.cases.filter((item) => !item.passed)) {
      process.stderr.write(`  - ${item.id}: ${item.failures.join("; ")}\n`);
    }
  }
  const writeBaselinePath = option("write-baseline");
  if (writeBaselinePath !== undefined) {
    if (requestedRevision === undefined) {
      throw new Error(
        "Writing a baseline requires --revision=<approved-revision>.",
      );
    }
    await writeSnapshot(writeBaselinePath, snapshot);
    process.stdout.write(
      `Baseline written to ${resolve(writeBaselinePath)}.\n`,
    );
  } else {
    const baselinePath = option("baseline") ?? defaultBaselinePath;
    const comparison = compareSnapshots({
      baseline: await readSnapshot(baselinePath),
      current: snapshot,
    });
    process.stdout.write(
      `Baseline ${comparison.baselineRevision} → ${comparison.currentRevision}: ${comparison.passed ? "NO REGRESSIONS" : "REGRESSION"}. ${comparison.improvements.length} improvements, ${comparison.additions.length} additions.\n`,
    );
    for (const regression of comparison.regressions) {
      process.stderr.write(`  - regression: ${regression}\n`);
    }
    for (const improvement of comparison.improvements) {
      process.stdout.write(`  - improvement: ${improvement}\n`);
    }
    for (const addition of comparison.additions) {
      process.stdout.write(`  - addition: ${addition}\n`);
    }
    if (!comparison.passed) process.exitCode = 1;
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
        : "Unknown Ask Driff suite evaluation error.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
