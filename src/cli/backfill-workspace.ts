import "dotenv/config";

import { parseArgs as parseNodeArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { execute as backfillWorkspace } from "@/changes/backfill-workspace.js";
import { execute as createPullRequestProjector } from "@/changes/project-pull-request.js";
import { execute as createPushProjector } from "@/changes/project-push.js";
import { execute as createReleaseProjector } from "@/changes/project-release.js";
import { execute as createDbClient } from "@/db/client.js";
import { execute as gatherPushContext } from "@/sources/github/gather-push-context.js";
import { execute as createGithubSource } from "@/sources/github/github-source.js";

const cliInputSchema = z.object({
  workspaceId: z.uuid(),
  repo: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/, "repo must use owner/name format"),
  apply: z.boolean(),
});

const environmentSchema = z.object({
  DATABASE_URL: z.url(),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
});

export interface CliInput {
  workspaceId: string;
  repo: string;
  apply: boolean;
}

export const parseArgs = (args: string[]): CliInput => {
  const parsed = parseNodeArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      "workspace-id": { type: "string" },
      repo: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });

  return cliInputSchema.parse({
    workspaceId: parsed.values["workspace-id"],
    repo: parsed.values.repo,
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
    const source = createGithubSource({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    });
    const result = await backfillWorkspace({
      db,
      workspaceId: command.workspaceId,
      repo: command.repo,
      apply: command.apply,
      source,
      loadPushContext: (range) =>
        gatherPushContext({
          ...range,
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY,
        }),
      pullRequestProjector: createPullRequestProjector({ db }),
      pushProjector: createPushProjector({ db }),
      releaseProjector: createReleaseProjector({ db }),
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
    process.stderr.write(`Canonical backfill failed: ${message}\n`);
    process.exitCode = 1;
  });
}
