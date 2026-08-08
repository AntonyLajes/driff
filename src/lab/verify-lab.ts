import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { execute as verifyScenario } from "@/lab/verify-scenario.js";

export interface ExecuteInput {
  filePath: string;
}

export const execute = async ({ filePath }: ExecuteInput): Promise<string> => {
  const raw = await readFile(resolve(filePath), "utf8");
  const scenario = JSON.parse(raw) as unknown;
  const summary = await verifyScenario(scenario);
  return `Verified ${summary.scenarioId}: ${summary.eventCount} events produced ${summary.expectedJobCount} expected jobs.`;
};

const runCli = async (): Promise<void> => {
  const filePath = process.argv[2];
  if (filePath === undefined) {
    throw new Error("Usage: npm run lab:verify -- <scenario.json>");
  }
  process.stdout.write(`${await execute({ filePath })}\n`);
};

const entrypointUrl =
  process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entrypointUrl === import.meta.url) {
  runCli().catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown Driff Lab verification error.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
