import "dotenv/config";

import { execute as loadEnv, type Env } from "@/config/env.js";
import { collectVersionWatchPaths } from "@/config/release-project-kind.js";
import {
  resolveWorkspaceSettingsForRepo,
  type MergedWorkspaceSettings,
} from "@/config/workspace-settings.js";
import { execute as createNotionDestination } from "@/destinations/notion/notion-destination.js";
import { execute as createDbClient } from "@/db/client.js";
import type { CorsRegistrationInput } from "@/http/cors.js";
import { buildGoogleOAuthRegistrationInput } from "@/http/routes/auth-google.js";
import { buildGithubMeRegistrationInput } from "@/http/routes/github-me.js";
import { execute as createServer } from "@/http/server.js";
import { execute as createWebhookDependencies } from "@/http/routes/webhooks-dependencies.js";
import type { HandlerInput as WebhookHandlerInput } from "@/http/routes/webhooks.js";
import { execute as createProcessPrJob } from "@/jobs/process-pr.js";
import { execute as createProcessReleaseJob } from "@/jobs/process-release.js";
import { execute as createProcessPushJob } from "@/jobs/process-push.js";
import { execute as createReleaseSummarizer, type ReleaseSummarizer } from "@/llm/release-summarizer.js";
import { execute as createPushSummarizer, type PushSummarizer } from "@/llm/push-summarizer.js";
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
  pushSummarizer?: PushSummarizer;
  destination?: Destination;
  processPrHandler?: JobHandler;
  processReleaseHandler?: JobHandler;
  processPushHandler?: JobHandler;
  promptVersion?: number;
  releasePromptVersion?: number;
  pushPromptVersion?: number;
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

const buildPushConfig = (
  workspace: MergedWorkspaceSettings,
): import("@/http/routes/webhook-push.js").PushWebhookConfig | null => {
  if (!workspace.notionPushesDatabaseId?.trim()) {
    return null;
  }
  return {
    branches: workspace.pushSummaryBranches ?? [],
    defaultBranch: workspace.githubRepoDefaultBranch,
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
  env: Env,
  webhookSecret: string,
  prSummaryBaseBranches: string[] | null,
  releaseConfig: import("@/http/routes/webhook-release.js").ReleaseWebhookConfig | null,
  db: Database,
): WebhookHandlerInput => {
  const resolveWebhookSettings = async (repoFullName: string) => {
    const merged = await resolveWorkspaceSettingsForRepo(db, repoFullName);
    if (merged === null) {
      return null;
    }
    const releaseNotesEnabled = Boolean(merged.notionReleasesDatabaseId?.trim());
    return {
      prSummaryBaseBranches: merged.prSummaryBaseBranches,
      releaseConfig: releaseNotesEnabled ? buildReleaseConfig(merged) : null,
      pushConfig: buildPushConfig(merged),
    };
  };

  if (input.webhook) {
    return {
      ...input.webhook,
      resolveWebhookSettings: input.webhook.resolveWebhookSettings ?? resolveWebhookSettings,
      prSummaryBaseBranches: input.webhook.prSummaryBaseBranches ?? prSummaryBaseBranches,
      releaseConfig: input.webhook.releaseConfig !== undefined ? input.webhook.releaseConfig : releaseConfig,
      pushConfig: input.webhook.pushConfig !== undefined ? input.webhook.pushConfig : null,
    };
  }

  return {
    webhookSecret,
    resolveWebhookSettings,
    prSummaryBaseBranches,
    releaseConfig,
    pushConfig: null,
    ...createWebhookDependencies({ db }),
  };
};

const readRepoFromJobPayload = (payload: Record<string, unknown>, jobType: string): string => {
  const repoRaw = payload.repo;
  if (typeof repoRaw !== "string" || repoRaw.trim().length === 0) {
    throw new Error(`Invalid ${jobType} payload: repo must be a non-empty string.`);
  }
  return repoRaw.trim();
};

const createDestinationForWorkspace = (
  env: Env,
  workspace: MergedWorkspaceSettings,
): Destination => {
  return createNotionDestination({
    token: env.NOTION_TOKEN,
    databaseId: workspace.notionPrDatabaseId,
    releasesDatabaseId: workspace.notionReleasesDatabaseId ?? undefined,
    pushesDatabaseId: workspace.notionPushesDatabaseId ?? undefined,
  });
};

const buildRuntimeDependencies = async (input: ExecuteInput): Promise<RuntimeDependencies> => {
  const env = loadEnv();
  const dbBundle =
    input.db && input.dbClient
      ? { db: input.db, client: input.dbClient }
      : createDbClient({ databaseUrl: env.DATABASE_URL });
  const db = input.db ?? dbBundle.db;
  const dbClient = input.dbClient ?? dbBundle.client ?? createNoopDbClient();
  const webhook = buildWebhookInput(
    input,
    env,
    env.GITHUB_WEBHOOK_SECRET,
    null,
    null,
    db,
  );
  const googleOAuth = buildGoogleOAuthRegistrationInput(env, db);
  const workspacesMe =
    googleOAuth !== undefined ? { db, jwtSecret: googleOAuth.jwtSecret } : undefined;
  const githubMeBase = buildGithubMeRegistrationInput(env);
  const githubMe =
    githubMeBase !== undefined ? { ...githubMeBase, db } : undefined;
  const server =
    input.server ??
    createServer({
      webhook,
      cors: input.cors ?? buildCorsFromEnv(env),
      googleOAuth,
      workspacesMe,
      githubMe,
    });
  const worker = await (async (): Promise<WorkerAdapter> => {
    if (input.worker) {
      return input.worker;
    }

    const queue = input.queue ?? createQueue({ db });
    const source =
      input.source ??
      createGithubSource({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
      });
    const summarizer = input.summarizer ?? (await createSummarizer({ apiKey: env.ANTHROPIC_API_KEY }));
    const releaseSummarizer =
      input.releaseSummarizer ??
      (await createReleaseSummarizer({ apiKey: env.ANTHROPIC_API_KEY }));
    const pushSummarizer =
      input.pushSummarizer ??
      (await createPushSummarizer({ apiKey: env.ANTHROPIC_API_KEY }));

    const resolveWorkspaceOrThrow = async (repo: string): Promise<MergedWorkspaceSettings> => {
      const workspace = await resolveWorkspaceSettingsForRepo(db, repo);
      if (workspace === null) {
        throw new Error(`Workspace settings not configured for repository "${repo}".`);
      }
      return workspace;
    };

    const processPrHandler =
      input.processPrHandler ??
      {
        execute: async (payload: Record<string, unknown>) => {
          const repo = readRepoFromJobPayload(payload, "process_pr");
          const workspace = await resolveWorkspaceOrThrow(repo);
          const destination =
            input.destination ?? createDestinationForWorkspace(env, workspace);
          const handler = createProcessPrJob({
            db,
            source,
            summarizer,
            destination,
            promptVersion: input.promptVersion ?? 1,
          });
          await handler.execute(payload);
        },
      };

    const processReleaseHandler =
      input.processReleaseHandler ??
      {
        execute: async (payload: Record<string, unknown>) => {
          const repo = readRepoFromJobPayload(payload, "process_release");
          const workspace = await resolveWorkspaceOrThrow(repo);
          const destination =
            input.destination ?? createDestinationForWorkspace(env, workspace);
          const handler = createProcessReleaseJob({
            db,
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_APP_PRIVATE_KEY,
            infoPlistPath: workspace.releaseInfoPlistPath ?? "",
            projectPbxprojPath: workspace.releaseProjectPbxprojPath ?? null,
            expoAppConfigPath: workspace.releaseExpoAppConfigPath ?? null,
            releasesNotionDatabaseId: workspace.notionReleasesDatabaseId,
            releaseCompareRootSha: workspace.releaseCompareRootSha,
            releaseSummarizer,
            destination,
            promptVersion: input.releasePromptVersion ?? 1,
          });
          await handler.execute(payload);
        },
      };

    const processPushHandler =
      input.processPushHandler ??
      {
        execute: async (payload: Record<string, unknown>) => {
          const repo = readRepoFromJobPayload(payload, "process_push");
          const workspace = await resolveWorkspaceOrThrow(repo);
          const destination =
            input.destination ?? createDestinationForWorkspace(env, workspace);
          const handler = createProcessPushJob({
            db,
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_APP_PRIVATE_KEY,
            pushSummarizer,
            destination,
            promptVersion: input.pushPromptVersion ?? 1,
            pushesNotionDatabaseId: workspace.notionPushesDatabaseId,
          });
          await handler.execute(payload);
        },
      };

    return createWorker({
      queue,
      handlers: {
        process_pr: processPrHandler,
        process_release: processReleaseHandler,
        process_push: processPushHandler,
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
