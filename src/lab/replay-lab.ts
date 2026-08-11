import "dotenv/config";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { execute as materializeScenario } from "@/lab/materialize-scenario.js";
import { execute as replayScenario } from "@/lab/replay-scenario.js";

const DEFAULT_TARGET_URL = "http://localhost:3000/webhooks/github";

export interface ExecuteInput {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

const splitAllowedHosts = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

export const execute = async ({ args, env }: ExecuteInput): Promise<string> => {
  const confirmDevelopment = args.includes("--confirm-development");
  const runIdArguments = args.filter((argument) =>
    argument.startsWith("--run-id="),
  );
  if (runIdArguments.length > 1) {
    throw new Error("Driff Lab accepts only one --run-id value.");
  }
  const runId = runIdArguments[0]?.slice("--run-id=".length);
  const positional = args.filter(
    (argument) =>
      argument !== "--confirm-development" && !argument.startsWith("--run-id="),
  );
  const scenarioPath = positional[0];
  const targetUrl = positional[1] ?? DEFAULT_TARGET_URL;

  if (scenarioPath === undefined || positional.length > 2) {
    throw new Error(
      "Usage: npm run lab:replay -- <scenario.json> [target-url] [--run-id=<id>] [--confirm-development]",
    );
  }

  const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
  if (webhookSecret === undefined || webhookSecret.trim().length === 0) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required for Driff Lab replay.");
  }

  const raw = await readFile(resolve(scenarioPath), "utf8");
  const scenario = materializeScenario({
    scenario: JSON.parse(raw) as unknown,
    ...(runId === undefined ? {} : { runId }),
  });
  const result = await replayScenario({
    scenario,
    targetUrl,
    webhookSecret,
    allowedRemoteHosts: splitAllowedHosts(env.DRIFF_LAB_ALLOWED_HOSTS),
    confirmDevelopment,
  });

  const runLabel = runId === undefined ? "" : ` (run ${runId})`;
  return `Replayed ${result.scenarioId}${runLabel}: ${result.events.length} events accepted by ${targetUrl}.`;
};

const entrypointUrl =
  process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entrypointUrl === import.meta.url) {
  execute({ args: process.argv.slice(2), env: process.env })
    .then((message) => {
      process.stdout.write(`${message}\n`);
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown Driff Lab replay error.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
