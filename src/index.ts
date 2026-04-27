import "dotenv/config";

import { execute as loadEnv } from "@/config/env.js";
import { execute as createNotionDestination } from "@/destinations/notion/notion-destination.js";
import { execute as createDbClient } from "@/db/client.js";
import { execute as createServer } from "@/http/server.js";
import { execute as createWebhookDependencies } from "@/http/routes/webhooks-dependencies.js";
import type { HandlerInput as WebhookHandlerInput } from "@/http/routes/webhooks.js";
import { execute as createProcessPrJob } from "@/jobs/process-pr.js";
import { execute as createProcessReleaseJob } from "@/jobs/process-release.js";
import { execute as createReleaseSummarizer, type ReleaseSummarizer } from "@/llm/release-summarizer.js";
import { execute as createSummarizer, type Summarizer } from "@/llm/summarizer.js";
import { execute as createQueue, type QueueAdapter } from "@/queue/queue.js";
import { execute as createWorker, type WorkerAdapter } from "@/queue/worker.js";
import { execute as createGithubSource } from "@/sources/github/github-source.js";
import type { Source } from "@/sources/source.js";
import type { Destination } from "@/destinations/destination.js";
import type { Database } from "@/db/client.js";
import type { JobHandler } from "@/queue/worker.js";

export interface ServerLike {
  listen: (options: { port: number; host: string }) => Promise<string>;
  close?: () => Promise<void>;
}

export interface DbClientLike {
  end?: () => Promise<unknown>;
}

export interface ExecuteInput {
  server?: ServerLike;
  db?: Database;
  dbClient?: DbClientLike;
  port?: number;
  host?: string;
  webhook?: WebhookHandlerInput;
  queue?: QueueAdapter;
  worker?: WorkerAdapter;
  source?: Source;
  summarizer?: Summarizer;
  releaseSummarizer?: ReleaseSummarizer;
  destination?: Destination;
  processPrHandler?: JobHandler;
  processReleaseHandler?: JobHandler;
  promptVersion?: number;
  releasePromptVersion?: number;
  startWorker?: boolean;
  registerSignalHandlers?: boolean;
}

interface RuntimeDependencies {
  dbClient: DbClientLike;
  server: ServerLike;
  worker: WorkerAdapter;
}

const createNoopDbClient = (): DbClientLike => ({
  end: async () => undefined,
});

const buildReleaseConfig = (
  env: ReturnType<typeof loadEnv>,
): import("@/http/routes/webhook-release.js").ReleaseWebhookConfig | null => {
  if (!env.NOTION_RELEASES_DATABASE_ID) {
    return null;
  }
  return {
    branch: env.RELEASE_VERSION_BRANCH ?? "",
    plistPath: env.RELEASE_INFO_PLIST_PATH ?? "",
    monitoredRepo: env.RELEASE_MONITORED_REPO ?? null,
  };
};

const buildWebhookInput = (
  input: ExecuteInput,
  webhookSecret: string,
  prSummaryBaseBranches: string[] | null,
  releaseConfig: import("@/http/routes/webhook-release.js").ReleaseWebhookConfig | null,
  db: Database,
): WebhookHandlerInput => {
  if (input.webhook) {
    return {
      ...input.webhook,
      prSummaryBaseBranches: input.webhook.prSummaryBaseBranches ?? prSummaryBaseBranches,
      releaseConfig: input.webhook.releaseConfig !== undefined ? input.webhook.releaseConfig : releaseConfig,
    };
  }

  return {
    webhookSecret,
    prSummaryBaseBranches,
    releaseConfig,
    ...createWebhookDependencies({ db }),
  };
};

const buildRuntimeDependencies = async (input: ExecuteInput): Promise<RuntimeDependencies> => {
  const env = loadEnv();
  const dbBundle =
    input.db && input.dbClient
      ? { db: input.db, client: input.dbClient }
      : createDbClient({ databaseUrl: env.DATABASE_URL });
  const db = input.db ?? dbBundle.db;
  const dbClient = input.dbClient ?? dbBundle.client ?? createNoopDbClient();

  const releaseNotesEnabled = Boolean(env.NOTION_RELEASES_DATABASE_ID);
  const webhook = buildWebhookInput(
    input,
    env.GITHUB_WEBHOOK_SECRET,
    env.PR_SUMMARY_BASE_BRANCHES,
    releaseNotesEnabled ? buildReleaseConfig(env) : null,
    db,
  );
  const server = input.server ?? createServer({ webhook });
  const worker = await (async (): Promise<WorkerAdapter> => {
    if (input.worker) {
      return input.worker;
    }

    const queue = input.queue ?? createQueue({ db });
    const processPrHandler =
      input.processPrHandler ??
      createProcessPrJob({
        db,
        source:
          input.source ??
          createGithubSource({
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_APP_PRIVATE_KEY,
          }),
        summarizer:
          input.summarizer ?? (await createSummarizer({ apiKey: env.ANTHROPIC_API_KEY })),
        destination:
          input.destination ??
          createNotionDestination({
            token: env.NOTION_TOKEN,
            databaseId: env.NOTION_DATABASE_ID,
            releasesDatabaseId: env.NOTION_RELEASES_DATABASE_ID,
          }),
        promptVersion: input.promptVersion ?? 1,
      });

    const processReleaseHandler =
      input.processReleaseHandler ??
      (releaseNotesEnabled
        ? createProcessReleaseJob({
            db,
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_APP_PRIVATE_KEY,
            infoPlistPath: env.RELEASE_INFO_PLIST_PATH ?? "",
            releaseSummarizer:
              input.releaseSummarizer ??
              (await createReleaseSummarizer({ apiKey: env.ANTHROPIC_API_KEY })),
            destination:
              input.destination ??
              createNotionDestination({
                token: env.NOTION_TOKEN,
                databaseId: env.NOTION_DATABASE_ID,
                releasesDatabaseId: env.NOTION_RELEASES_DATABASE_ID,
              }),
            promptVersion: input.releasePromptVersion ?? 1,
          })
        : { execute: async () => undefined });

    return createWorker({
      queue,
      handlers: {
        process_pr: processPrHandler,
        process_release: processReleaseHandler,
      },
    });
  })();

  return {
    dbClient,
    server,
    worker,
  };
};

const registerShutdownSignals = (shutdown: () => Promise<void>): void => {
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
};

export const execute = async (
  input: ExecuteInput = {},
): Promise<{ address: string; server: ServerLike; worker: WorkerAdapter; shutdown: () => Promise<void> }> => {
  const env = loadEnv();
  const runtime = await buildRuntimeDependencies(input);
  const workerRunPromise =
    input.startWorker === false ? undefined : runtime.worker.run().catch(() => undefined);
  const port = input.port ?? env.PORT;
  const host = input.host ?? "0.0.0.0";
  const address = await runtime.server.listen({ port, host });

  let isShuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    runtime.worker.stop();

    const closeOperations: Array<Promise<unknown>> = [];
    if (workerRunPromise) {
      closeOperations.push(workerRunPromise);
    }
    if (runtime.server.close) {
      closeOperations.push(runtime.server.close());
    }
    if (runtime.dbClient.end) {
      closeOperations.push(runtime.dbClient.end());
    }

    await Promise.allSettled(closeOperations);
  };

  if (input.registerSignalHandlers) {
    registerShutdownSignals(shutdown);
  }

  return {
    address,
    server: runtime.server,
    worker: runtime.worker,
    shutdown,
  };
};

/* c8 ignore next 3 */
if (import.meta.url === `file://${process.argv[1]}`) {
  void execute({ registerSignalHandlers: true });
}
