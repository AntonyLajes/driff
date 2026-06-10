import "dotenv/config";

import { execute as loadEnv, type Env } from "@/config/env.js";
import { collectVersionWatchPaths } from "@/config/release-project-kind.js";
import {
  hasReleaseVersionSource,
  resolveWorkspaceSettingsForRepo,
  type MergedWorkspaceSettings,
} from "@/config/workspace-settings.js";
import { loadWorkspaceDestination } from "@/destinations/load-workspace-destinations.js";
import { execute as createDbClient } from "@/db/client.js";
import type { CorsRegistrationInput } from "@/http/cors.js";
import { buildGoogleOAuthRegistrationInput } from "@/http/routes/auth-google.js";
import { buildGithubMeRegistrationInput } from "@/http/routes/github-me.js";
import { buildDestinationsMeRegistrationInput } from "@/http/routes/destinations-me.js";
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
  // Release notes run when a version source + branch are configured (input config),
  // regardless of which output destination publishes them.
  if (!hasReleaseVersionSource(workspace) || !workspace.releaseVersionBranch?.trim()) {
    return null;
  }
  return {
    branch: workspace.releaseVersionBranch,
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
  // Push summaries are opt-in: enabled when the workspace configured push branches.
  const branches = workspace.pushSummaryBranches ?? [];
  if (branches.length === 0) {
    return null;
  }
  return {
    branches,
    defaultBranch: workspace.repoDefaultBranch,
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
    // GitHub is the only provider with a webhook ingress today.
    const merged = await resolveWorkspaceSettingsForRepo(db, "github", repoFullName);
    if (merged === null) {
      return null;
    }
    return {
      prSummaryBaseBranches: merged.prSummaryBaseBranches,
      releaseConfig: buildReleaseConfig(merged),
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

const createDestinationForWorkspace = async (
  db: Database,
  jwtSecret: string,
  workspace: MergedWorkspaceSettings,
): Promise<Destination> => {
  const destination = await loadWorkspaceDestination(db, workspace.workspaceId, jwtSecret);
  if (destination === null) {
    throw new Error(
      `No enabled output destination configured for workspace "${workspace.workspaceId}".`,
    );
  }
  return destination;
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
  const destinationsMeBase = buildDestinationsMeRegistrationInput(env);
  const destinationsMe =
    destinationsMeBase !== undefined ? { ...destinationsMeBase, db } : undefined;
  const server =
    input.server ??
    createServer({
      webhook,
      cors: input.cors ?? buildCorsFromEnv(env),
      googleOAuth,
      workspacesMe,
      meStats: workspacesMe,
      teamsMe:
        workspacesMe !== undefined
          ? {
              ...workspacesMe,
              resendApiKey: env.RESEND_API_KEY,
              resendFrom: env.RESEND_FROM,
              frontendUrl: env.FRONTEND_URL,
            }
          : undefined,
      githubMe,
      destinationsMe,
      health: { db },
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
      // GitHub is the only provider with a job pipeline today.
      const workspace = await resolveWorkspaceSettingsForRepo(db, "github", repo);
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
            input.destination ??
            (await createDestinationForWorkspace(db, env.AUTH_JWT_SECRET ?? "", workspace));
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
            input.destination ??
            (await createDestinationForWorkspace(db, env.AUTH_JWT_SECRET ?? "", workspace));
          const handler = createProcessReleaseJob({
            db,
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_APP_PRIVATE_KEY,
            infoPlistPath: workspace.releaseInfoPlistPath ?? "",
            projectPbxprojPath: workspace.releaseProjectPbxprojPath ?? null,
            expoAppConfigPath: workspace.releaseExpoAppConfigPath ?? null,
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
            input.destination ??
            (await createDestinationForWorkspace(db, env.AUTH_JWT_SECRET ?? "", workspace));
          const handler = createProcessPushJob({
            db,
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_APP_PRIVATE_KEY,
            pushSummarizer,
            destination,
            promptVersion: input.pushPromptVersion ?? 1,
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
    input.startWorker === false
      ? undefined
      : runtime.worker.run().catch((error) => {
          // The run loop now survives transient errors on its own; reaching here
          // means it terminated unexpectedly. Surface it instead of swallowing.
          console.error("[worker] run loop terminated unexpectedly", error);
        });
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
