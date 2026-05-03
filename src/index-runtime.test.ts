import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listen = vi.fn(async () => "http://0.0.0.0:3000");
  const close = vi.fn(async () => undefined);
  const server = { listen, close };
  const createServer = vi.fn(() => server);
  const db = { fake: true };
  const end = vi.fn(async () => undefined);
  const createDbClient = vi.fn<
    () => { db: { fake: boolean }; client?: { end: () => Promise<undefined> } }
  >(() => ({ db, client: { end } }));
  const createWebhookDependencies = vi.fn(() => ({
    findWebhookEventByDeliveryId: async () => false,
    insertWebhookEvent: async () => undefined,
    enqueueProcessPrJob: async () => undefined,
    enqueueProcessReleaseJob: async () => undefined,
  }));
  const queue = {
    enqueue: vi.fn(async () => "job-1"),
    dequeue: vi.fn(async () => null),
    markDone: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    reschedule: vi.fn(async () => undefined),
  };
  const createQueue = vi.fn(() => queue);
  const worker = {
    runOnce: vi.fn(async () => false),
    run: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  const createWorker = vi.fn(() => worker);
  const processPrHandler = {
    execute: vi.fn(async () => undefined),
  };
  const createProcessPr = vi.fn(() => processPrHandler);
  const processReleaseHandler = { execute: vi.fn(async () => undefined) };
  const createProcessRelease = vi.fn(() => processReleaseHandler);
  const source = { fetchPullRequest: vi.fn(async () => ({})) };
  const createGithubSource = vi.fn(() => source);
  const summarizer = { summarizePR: vi.fn(async () => ({})), prompt: "prompt" };
  const createSummarizer = vi.fn(async () => summarizer);
  const destination = {
    publishPR: vi.fn(async () => ({ pageId: "page-id" })),
    publishRelease: vi.fn(async () => ({ pageId: "rel-id" })),
  };
  const createNotionDestination = vi.fn(() => destination);

  return {
    close,
    createGithubSource,
    createDbClient,
    createNotionDestination,
    createProcessPr,
    createProcessRelease,
    createQueue,
    createServer,
    createSummarizer,
    createWebhookDependencies,
    createWorker,
    db,
    end,
    listen,
    server,
    worker,
  };
});

vi.mock("@/http/server.js", () => ({
  execute: mocks.createServer,
}));

vi.mock("@/db/client.js", () => ({
  execute: mocks.createDbClient,
}));

vi.mock("@/http/routes/webhooks-dependencies.js", () => ({
  execute: mocks.createWebhookDependencies,
}));

vi.mock("@/queue/queue.js", () => ({
  execute: mocks.createQueue,
}));

vi.mock("@/queue/worker.js", () => ({
  execute: mocks.createWorker,
}));

vi.mock("@/jobs/process-pr.js", () => ({
  execute: mocks.createProcessPr,
}));

vi.mock("@/jobs/process-release.js", () => ({
  execute: mocks.createProcessRelease,
}));

vi.mock("@/llm/release-summarizer.js", () => ({
  execute: async () => ({
    prompt: "release-prompt",
    summarizeRelease: vi.fn(),
  }),
}));

vi.mock("@/sources/github/github-source.js", () => ({
  execute: mocks.createGithubSource,
}));

vi.mock("@/llm/summarizer.js", () => ({
  execute: mocks.createSummarizer,
}));

vi.mock("@/destinations/notion/notion-destination.js", () => ({
  execute: mocks.createNotionDestination,
}));

vi.mock("@/config/workspace-settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/workspace-settings.js")>();
  return {
    ...actual,
    execute: async (_db: unknown, env: import("@/config/env.js").Env) => {
      const merged = actual.mergeWorkspaceSettings(undefined, env);
      actual.validateMergedWorkspaceSettings(merged);
      return merged;
    },
  };
});

import { execute } from "@/index.js";

describe("index execute runtime wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listen.mockResolvedValue("http://0.0.0.0:3000");
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/driff";
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY = "private-key";
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";
    process.env.NOTION_TOKEN = "notion-token";
    process.env.NOTION_DATABASE_ID = "database-id";
    process.env.PORT = "3000";
    process.env.LOG_LEVEL = "info";
    process.env.NODE_ENV = "test";
    delete process.env.NOTION_RELEASES_DATABASE_ID;
    delete process.env.RELEASE_INFO_PLIST_PATH;
    delete process.env.RELEASE_VERSION_BRANCH;
    delete process.env.RELEASE_PROJECT_PBXPROJ_PATH;
    delete process.env.RELEASE_MONITORED_REPO;
  });

  it("should wire default runtime dependencies from env", async () => {
    const result = await execute();

    expect(mocks.createDbClient).toHaveBeenCalledWith({
      databaseUrl: "postgres://user:pass@localhost:5432/driff",
    });
    expect(mocks.createWebhookDependencies).toHaveBeenCalledWith({ db: mocks.db });
    expect(mocks.createServer).toHaveBeenCalledWith({
      webhook: expect.objectContaining({
        webhookSecret: "webhook-secret",
        prSummaryBaseBranches: null,
      }),
      cors: { kind: "off" },
    });
    expect(mocks.createGithubSource).toHaveBeenCalledWith({
      appId: "123456",
      privateKey: "private-key",
    });
    expect(mocks.createSummarizer).toHaveBeenCalledWith({
      apiKey: "anthropic-key",
    });
    expect(mocks.createNotionDestination).toHaveBeenCalledWith({
      token: "notion-token",
      databaseId: "database-id",
      releasesDatabaseId: undefined,
    });
    expect(mocks.createQueue).toHaveBeenCalledWith({ db: mocks.db });
    expect(mocks.createProcessPr).toHaveBeenCalledOnce();
    expect(mocks.createWorker).toHaveBeenCalledOnce();
    expect(mocks.worker.run).toHaveBeenCalledOnce();

    await result.shutdown();
    expect(mocks.worker.stop).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("should skip worker run when startWorker is false", async () => {
    await execute({ startWorker: false });

    expect(mocks.worker.run).not.toHaveBeenCalled();
  });

  it("should fallback to noop db client when factory omits client", async () => {
    mocks.createDbClient.mockReturnValueOnce({ db: mocks.db });

    const result = await execute({ startWorker: false });

    await expect(result.shutdown()).resolves.toBeUndefined();
  });

  it("should reuse injected dependencies when provided", async () => {
    const injectedRun = vi.fn(async () => undefined);
    const injectedRunOnce = vi.fn(async () => false);
    const injectedStop = vi.fn();
    const injectedWorker = {
      runOnce: injectedRunOnce,
      run: injectedRun,
      stop: injectedStop,
    };
    const injectedServer = {
      listen: vi.fn(async () => "http://127.0.0.1:4000"),
      close: vi.fn(async () => undefined),
    };
    const result = await execute({
      server: injectedServer,
      worker: injectedWorker,
      db: {} as never,
      dbClient: { end: vi.fn(async () => undefined) },
      webhook: {
        webhookSecret: "webhook-secret",
        findWebhookEventByDeliveryId: async () => false,
        insertWebhookEvent: async () => undefined,
        enqueueProcessPrJob: async () => undefined,
        enqueueProcessReleaseJob: async () => undefined,
      },
    });

    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.createDbClient).not.toHaveBeenCalled();
    expect(injectedRun).toHaveBeenCalledOnce();
    expect(result.address).toBe("http://127.0.0.1:4000");
  });
});
