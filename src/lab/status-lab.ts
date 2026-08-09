import "dotenv/config";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { eq, sql } from "drizzle-orm";

import { execute as createDbClient } from "@/db/client.js";
import { jobsTable, webhookEventsTable } from "@/db/schema.js";
import { execute as inspectReplay } from "@/lab/inspect-replay.js";

const parseArgs = (args: readonly string[]) => {
  const runIds = args.filter((argument) => argument.startsWith("--run-id="));
  const waits = args.filter((argument) => argument.startsWith("--wait="));
  const positional = args.filter(
    (argument) =>
      !argument.startsWith("--run-id=") && !argument.startsWith("--wait="),
  );
  if (positional.length !== 1 || runIds.length > 1 || waits.length > 1) {
    throw new Error(
      "Usage: npm run lab:status -- <scenario.json> [--run-id=<id>] [--wait=<seconds>]",
    );
  }
  const waitSeconds = Number(waits[0]?.slice("--wait=".length) ?? "0");
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 300) {
    throw new Error("Driff Lab wait must be an integer from 0 to 300 seconds.");
  }
  return {
    scenarioPath: positional[0]!,
    runId: runIds[0]?.slice("--run-id=".length),
    waitSeconds,
  };
};

export const execute = async (input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}): Promise<string> => {
  const { scenarioPath, runId, waitSeconds } = parseArgs(input.args);
  const databaseUrl = input.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for Driff Lab status.");

  const raw = await readFile(resolve(scenarioPath), "utf8");
  const scenario = JSON.parse(raw) as unknown;
  const { db, client } = createDbClient({ databaseUrl });
  const store = {
    hasWebhook: async (deliveryId: string) => {
      const rows = await db
        .select({ id: webhookEventsTable.id })
        .from(webhookEventsTable)
        .where(eq(webhookEventsTable.deliveryId, deliveryId))
        .limit(1);
      return rows.length > 0;
    },
    findJobs: async (deliveryId: string) =>
      db
        .select({
          type: jobsTable.type,
          status: jobsTable.status,
          attempts: jobsTable.attempts,
          lastError: jobsTable.lastError,
        })
        .from(jobsTable)
        .where(sql`${jobsTable.payload}->>'deliveryId' = ${deliveryId}`),
  };

  const deadline = Date.now() + waitSeconds * 1_000;
  try {
    while (true) {
      const status = await inspectReplay({
        scenario,
        ...(runId === undefined ? {} : { runId }),
        store,
      });
      if (
        status.status === "passed" ||
        status.status === "failed" ||
        Date.now() >= deadline
      ) {
        return JSON.stringify(status, null, 2);
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000));
    }
  } finally {
    await client.end();
  }
};

const entrypointUrl =
  process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entrypointUrl === import.meta.url) {
  execute({ args: process.argv.slice(2), env: process.env })
    .then((message) => process.stdout.write(`${message}\n`))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Unknown Driff Lab status error."}\n`,
      );
      process.exitCode = 1;
    });
}
