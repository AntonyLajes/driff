import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { execute as parseScenario } from "@/lab/scenario.js";

export interface ExecuteInput {
  filePath: string;
}

export interface ValidationSummary {
  scenarioId: string;
  eventCount: number;
  expectedJobCount: number;
}

export const execute = async ({
  filePath,
}: ExecuteInput): Promise<ValidationSummary> => {
  const absolutePath = resolve(filePath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const scenario = parseScenario(parsed);

  return {
    scenarioId: scenario.id,
    eventCount: scenario.events.length,
    expectedJobCount: scenario.events.reduce(
      (total, event) => total + event.expectedJobs.length,
      0,
    ),
  };
};

const runCli = async (): Promise<void> => {
  const filePath = process.argv[2];
  if (filePath === undefined) {
    throw new Error("Usage: npm run lab:validate -- <scenario.json>");
  }

  const summary = await execute({ filePath });
  process.stdout.write(
    `Validated ${summary.scenarioId}: ${summary.eventCount} events, ${summary.expectedJobCount} expected jobs.\n`,
  );
};

const entrypointUrl =
  process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entrypointUrl === import.meta.url) {
  runCli().catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown Driff Lab validation error.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
