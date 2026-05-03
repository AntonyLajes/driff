import "dotenv/config";

import { execute as loadEnv, type Env } from "@/config/env.js";
import { collectVersionWatchPaths } from "@/config/release-project-kind.js";
import {
  execute as loadWorkspaceSettings,
  type MergedWorkspaceSettings,
} from "@/config/workspace-settings.js";
import { execute as createNotionDestination } from "@/destinations/notion/notion-destination.js";
import { execute as createDbClient } from "@/db/client.js";
import type { CorsRegistrationInput } from "@/http/cors.js";
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
  cors?: CorsRegistrationInput;
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
  workspace: MergedWorkspaceSettings,
): import("@/http/routes/webhook-release.js").ReleaseWebhookConfig | null => {
  if (!workspace.notionReleasesDatabaseId?.trim()) {
    return null;
  }
  return {
    branch: workspace.releaseVersionBranch ?? "",
    versionWatchPaths: collectVersionWatchPaths(
      workspace.releaseInfoPlistPath,
      workspace.releaseProjectPbxprojPath,
      workspace.releaseExpoAppConfigPath,
    ),
    monitoredRepo: workspace.releaseMonitoredRepo ?? null,
  };
};

const buildCorsFromEnv = (env: Env): CorsRegistrationInput => {
  if (env.CORS_ORIGINS.length > 0) {
    return { kind: "allowlist", origins: env.CORS_ORIGINS };
  }
  if (env.NODE_ENV === "development") {
    return { kind: "reflect" };
  }
  return { kind: "off" };
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

  const workspace = await loadWorkspaceSettings(db, env);
  const releaseNotesEnabled = Boolean(workspace.notionReleasesDatabaseId?.trim());
  const webhook = buildWebhookInput(
    input,
    env.GITHUB_WEBHOOK_SECRET,
    workspace.prSummaryBaseBranches,
    releaseNotesEnabled ? buildReleaseConfig(workspace) : null,
    db,
  );
  const server =
    input.server ??
    createServer({
      webhook,
      cors: input.cors ?? buildCorsFromEnv(env),
    });
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
            databaseId: workspace.notionPrDatabaseId,
            releasesDatabaseId: workspace.notionReleasesDatabaseId ?? undefined,
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
            infoPlistPath: workspace.releaseInfoPlistPath ?? "",
            projectPbxprojPath: workspace.releaseProjectPbxprojPath ?? null,
            expoAppConfigPath: workspace.releaseExpoAppConfigPath ?? null,
            releasesNotionDatabaseId: workspace.notionReleasesDatabaseId,
            releaseCompareRootSha: workspace.releaseCompareRootSha,
            releaseSummarizer:
              input.releaseSummarizer ??
              (await createReleaseSummarizer({ apiKey: env.ANTHROPIC_API_KEY })),
            destination:
              input.destination ??
              createNotionDestination({
                token: env.NOTION_TOKEN,
                databaseId: workspace.notionPrDatabaseId,
                releasesDatabaseId: workspace.notionReleasesDatabaseId ?? undefined,
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
