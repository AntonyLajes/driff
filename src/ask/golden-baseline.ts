import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import type { GoldenSuiteEvaluation } from "@/ask/evaluate-golden-suite.js";

const goldenCaseSnapshotSchema = z
  .object({
    id: z.string().min(1),
    passed: z.boolean(),
    returnedMatches: z.number().int().nonnegative(),
    citedMatches: z.number().int().nonnegative(),
  })
  .refine((item) => item.citedMatches <= item.returnedMatches, {
    message: "citedMatches cannot exceed returnedMatches",
  });

const goldenCorpusSnapshotSchema = z
  .object({
    corpusId: z.string().min(1),
    totalCases: z.number().int().positive(),
    passedCases: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1),
    citationPrecision: z.number().min(0).max(1),
    refusalAccuracy: z.number().min(0).max(1),
    cases: z.array(goldenCaseSnapshotSchema),
  })
  .superRefine((corpus, context) => {
    const caseIds = new Set(corpus.cases.map((item) => item.id));
    if (caseIds.size !== corpus.cases.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "case ids must be unique within a corpus",
      });
    }
    if (corpus.cases.length !== corpus.totalCases) {
      context.addIssue({
        code: "custom",
        path: ["totalCases"],
        message: "totalCases must match the number of cases",
      });
    }
    if (
      corpus.cases.filter((item) => item.passed).length !== corpus.passedCases
    ) {
      context.addIssue({
        code: "custom",
        path: ["passedCases"],
        message: "passedCases must match passing case records",
      });
    }
    if (
      Math.abs(corpus.passRate - corpus.passedCases / corpus.totalCases) > 1e-12
    ) {
      context.addIssue({
        code: "custom",
        path: ["passRate"],
        message: "passRate must match passedCases / totalCases",
      });
    }
  });

export const goldenSuiteSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().min(1),
    totalCorpora: z.number().int().positive(),
    totalCases: z.number().int().positive(),
    passedCases: z.number().int().nonnegative(),
    thresholdPassed: z.boolean(),
    corpora: z.array(goldenCorpusSnapshotSchema),
  })
  .superRefine((suite, context) => {
    const corpusIds = new Set(suite.corpora.map((corpus) => corpus.corpusId));
    if (corpusIds.size !== suite.corpora.length) {
      context.addIssue({
        code: "custom",
        path: ["corpora"],
        message: "corpus ids must be unique",
      });
    }
    if (suite.corpora.length !== suite.totalCorpora) {
      context.addIssue({
        code: "custom",
        path: ["totalCorpora"],
        message: "totalCorpora must match the number of corpora",
      });
    }
    if (
      suite.corpora.reduce((total, corpus) => total + corpus.totalCases, 0) !==
      suite.totalCases
    ) {
      context.addIssue({
        code: "custom",
        path: ["totalCases"],
        message: "totalCases must match the corpus totals",
      });
    }
    if (
      suite.corpora.reduce((total, corpus) => total + corpus.passedCases, 0) !==
      suite.passedCases
    ) {
      context.addIssue({
        code: "custom",
        path: ["passedCases"],
        message: "passedCases must match the corpus totals",
      });
    }
  });

export type GoldenSuiteSnapshot = z.infer<typeof goldenSuiteSnapshotSchema>;

export interface GoldenBaselineComparison {
  baselineRevision: string;
  currentRevision: string;
  passed: boolean;
  regressions: string[];
  improvements: string[];
  additions: string[];
}

const percentage = (value: number): string => `${(value * 100).toFixed(1)}%`;

export const createSnapshot = (
  evaluation: GoldenSuiteEvaluation,
  revision: string,
): GoldenSuiteSnapshot =>
  goldenSuiteSnapshotSchema.parse({
    schemaVersion: 1,
    revision,
    totalCorpora: evaluation.totalCorpora,
    totalCases: evaluation.totalCases,
    passedCases: evaluation.passedCases,
    thresholdPassed: evaluation.thresholdPassed,
    corpora: evaluation.corpora.map((corpus) => ({
      corpusId: corpus.corpusId,
      totalCases: corpus.totalCases,
      passedCases: corpus.passedCases,
      passRate: corpus.passRate,
      citationPrecision: corpus.citationPrecision,
      refusalAccuracy: corpus.refusalAccuracy,
      cases: corpus.cases.map((item) => ({
        id: item.id,
        passed: item.passed,
        returnedMatches: item.returnedMatches,
        citedMatches: item.citedMatches,
      })),
    })),
  });

export const readSnapshot = async (
  filePath: string,
): Promise<GoldenSuiteSnapshot> => {
  const raw = await readFile(resolve(filePath), "utf8");
  return goldenSuiteSnapshotSchema.parse(JSON.parse(raw) as unknown);
};

export const writeSnapshot = async (
  filePath: string,
  snapshot: GoldenSuiteSnapshot,
): Promise<void> => {
  await writeFile(
    resolve(filePath),
    `${JSON.stringify(goldenSuiteSnapshotSchema.parse(snapshot), null, 2)}\n`,
    "utf8",
  );
};

const compareMetric = (input: {
  label: string;
  baseline: number;
  current: number;
  regressions: string[];
  improvements: string[];
}): void => {
  if (input.current < input.baseline) {
    input.regressions.push(
      `${input.label} decreased from ${percentage(input.baseline)} to ${percentage(input.current)}`,
    );
  } else if (input.current > input.baseline) {
    input.improvements.push(
      `${input.label} increased from ${percentage(input.baseline)} to ${percentage(input.current)}`,
    );
  }
};

export const compareSnapshots = (input: {
  baseline: GoldenSuiteSnapshot;
  current: GoldenSuiteSnapshot;
}): GoldenBaselineComparison => {
  const baseline = goldenSuiteSnapshotSchema.parse(input.baseline);
  const current = goldenSuiteSnapshotSchema.parse(input.current);
  const regressions: string[] = [];
  const improvements: string[] = [];
  const additions: string[] = [];
  const currentCorpora = new Map(
    current.corpora.map((corpus) => [corpus.corpusId, corpus]),
  );

  for (const baselineCorpus of baseline.corpora) {
    const currentCorpus = currentCorpora.get(baselineCorpus.corpusId);
    if (currentCorpus === undefined) {
      regressions.push(`corpus ${baselineCorpus.corpusId} was removed`);
      continue;
    }
    compareMetric({
      label: `${baselineCorpus.corpusId} pass rate`,
      baseline: baselineCorpus.passRate,
      current: currentCorpus.passRate,
      regressions,
      improvements,
    });
    compareMetric({
      label: `${baselineCorpus.corpusId} citation precision`,
      baseline: baselineCorpus.citationPrecision,
      current: currentCorpus.citationPrecision,
      regressions,
      improvements,
    });
    compareMetric({
      label: `${baselineCorpus.corpusId} refusal accuracy`,
      baseline: baselineCorpus.refusalAccuracy,
      current: currentCorpus.refusalAccuracy,
      regressions,
      improvements,
    });

    const currentCases = new Map(
      currentCorpus.cases.map((item) => [item.id, item]),
    );
    for (const baselineCase of baselineCorpus.cases) {
      const currentCase = currentCases.get(baselineCase.id);
      if (currentCase === undefined) {
        regressions.push(
          `${baselineCorpus.corpusId}/${baselineCase.id} was removed`,
        );
      } else if (baselineCase.passed && !currentCase.passed) {
        regressions.push(
          `${baselineCorpus.corpusId}/${baselineCase.id} changed from pass to fail`,
        );
      } else if (!baselineCase.passed && currentCase.passed) {
        improvements.push(
          `${baselineCorpus.corpusId}/${baselineCase.id} changed from fail to pass`,
        );
      }
    }

    const baselineCaseIds = new Set(
      baselineCorpus.cases.map((item) => item.id),
    );
    for (const currentCase of currentCorpus.cases) {
      if (!baselineCaseIds.has(currentCase.id)) {
        additions.push(`${currentCorpus.corpusId}/${currentCase.id} was added`);
      }
    }
  }

  const baselineCorpusIds = new Set(
    baseline.corpora.map((corpus) => corpus.corpusId),
  );
  for (const currentCorpus of current.corpora) {
    if (!baselineCorpusIds.has(currentCorpus.corpusId)) {
      additions.push(`corpus ${currentCorpus.corpusId} was added`);
    }
  }

  return {
    baselineRevision: baseline.revision,
    currentRevision: current.revision,
    passed: regressions.length === 0,
    regressions,
    improvements,
    additions,
  };
};
