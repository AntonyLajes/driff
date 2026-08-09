import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  execute as evaluateCorpus,
  type GoldenEvaluation,
} from "@/ask/evaluate-golden-corpus.js";

export interface ExecuteInput {
  directoryPath: string;
}

export interface GoldenSuiteEvaluation {
  totalCorpora: number;
  totalCases: number;
  passedCases: number;
  thresholdPassed: boolean;
  corpora: GoldenEvaluation[];
}

export const execute = async ({
  directoryPath,
}: ExecuteInput): Promise<GoldenSuiteEvaluation> => {
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
  return {
    totalCorpora: corpora.length,
    totalCases: corpora.reduce((total, corpus) => total + corpus.totalCases, 0),
    passedCases: corpora.reduce(
      (total, corpus) => total + corpus.passedCases,
      0,
    ),
    thresholdPassed: corpora.every((corpus) => corpus.thresholdPassed),
    corpora,
  };
};

const percentage = (value: number): string => `${(value * 100).toFixed(1)}%`;

const runCli = async (): Promise<void> => {
  const defaultDirectory = dirname(
    fileURLToPath(new URL("./fixtures/ride-pack-golden.json", import.meta.url)),
  );
  const evaluation = await execute({
    directoryPath: process.argv[2] ?? defaultDirectory,
  });
  process.stdout.write(
    `Ask suite: ${evaluation.passedCases}/${evaluation.totalCases} cases passed across ${evaluation.totalCorpora} corpora. Threshold: ${evaluation.thresholdPassed ? "PASS" : "FAIL"}.\n`,
  );
  for (const corpus of evaluation.corpora) {
    process.stdout.write(
      `- ${corpus.corpusId}: ${corpus.passedCases}/${corpus.totalCases}, citations ${percentage(corpus.citationPrecision)}, refusals ${percentage(corpus.refusalAccuracy)}.\n`,
    );
    for (const item of corpus.cases.filter((item) => !item.passed)) {
      process.stderr.write(`  - ${item.id}: ${item.failures.join("; ")}\n`);
    }
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
