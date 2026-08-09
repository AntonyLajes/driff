import "dotenv/config";

import { parseArgs as parseNodeArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { execute as createDbClient } from "@/db/client.js";
import { execute as backfillLineages } from "@/lineages/backfill-workspace.js";

const cliInputSchema = z.object({
  workspaceId: z.uuid(),
  apply: z.boolean(),
});

const environmentSchema = z.object({ DATABASE_URL: z.url() });

export interface CliInput {
  workspaceId: string;
  apply: boolean;
}

export const parseArgs = (args: string[]): CliInput => {
  const parsed = parseNodeArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      "workspace-id": { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  return cliInputSchema.parse({
    workspaceId: parsed.values["workspace-id"],
    apply: parsed.values.apply,
  });
};

export const main = async (
  args: string[] = process.argv.slice(2),
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  const command = parseArgs(args);
  const env = environmentSchema.parse(rawEnv);
  const { client, db } = createDbClient({ databaseUrl: env.DATABASE_URL });
  try {
    const result = await backfillLineages({
      db,
      workspaceId: command.workspaceId,
      apply: command.apply,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await client.end();
  }
};

const directEntry = process.argv[1];
if (
  directEntry !== undefined &&
  import.meta.url === pathToFileURL(directEntry).href
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Lineage backfill failed: ${message}\n`);
    process.exitCode = 1;
  });
}
