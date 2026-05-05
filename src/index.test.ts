import { describe, expect, it, vi } from "vitest";

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

describe("index execute", () => {
  const setRequiredEnv = () => {
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
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.AUTH_JWT_SECRET;
    delete process.env.AUTH_PUBLIC_URL;
    delete process.env.FRONTEND_URL;
  };

  it("should call listen with default host and port", async () => {
    setRequiredEnv();
    const listen = vi.fn(async () => "http://0.0.0.0:3000");
    const close = vi.fn(async () => undefined);
    const runOnce = vi.fn(async () => false);
    const run = vi.fn(async () => undefined);
    const stop = vi.fn();
    const server = { listen, close };
    const worker = { runOnce, run, stop };
    const end = vi.fn(async () => undefined);
    const db = {} as never;

    const result = await execute({
      server,
      worker,
      db,
      dbClient: { end },
      webhook: {
        webhookSecret: "webhook-secret",
        prSummaryBaseBranches: null,
        releaseConfig: null,
        findWebhookEventByDeliveryId: async () => false,
        insertWebhookEvent: async () => undefined,
        enqueueProcessPrJob: async () => undefined,
        enqueueProcessReleaseJob: async () => undefined,
      },
    });

    expect(listen).toHaveBeenCalledWith({
      port: 3000,
      host: "0.0.0.0",
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result.address).toBe("http://0.0.0.0:3000");
    expect(result.server).toBe(server);

    await result.shutdown();
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("should call listen with custom host and port", async () => {
    setRequiredEnv();
    const listen = vi.fn(async () => "http://127.0.0.1:4000");
    const server = { listen, close: vi.fn(async () => undefined) };
    const worker = {
      runOnce: vi.fn(async () => false),
      run: vi.fn(async () => undefined),
      stop: vi.fn(),
    };

    const result = await execute({
      server,
      worker,
      db: {} as never,
      dbClient: { end: vi.fn(async () => undefined) },
      webhook: {
        webhookSecret: "webhook-secret",
        prSummaryBaseBranches: null,
        releaseConfig: null,
        findWebhookEventByDeliveryId: async () => false,
        insertWebhookEvent: async () => undefined,
        enqueueProcessPrJob: async () => undefined,
        enqueueProcessReleaseJob: async () => undefined,
      },
      host: "127.0.0.1",
      port: 4000,
      startWorker: false,
    });

    expect(listen).toHaveBeenCalledWith({
      port: 4000,
      host: "127.0.0.1",
    });
    expect(worker.run).not.toHaveBeenCalled();
    expect(result.address).toBe("http://127.0.0.1:4000");
  });

  it("should register signal handlers when requested", async () => {
    setRequiredEnv();
    const onceSpy = vi.spyOn(process, "once");
    const server = {
      listen: vi.fn(async () => "http://0.0.0.0:3000"),
      close: vi.fn(async () => undefined),
    };
    const worker = {
      runOnce: vi.fn(async () => false),
      run: vi.fn(async () => undefined),
      stop: vi.fn(),
    };

    await execute({
      server,
      worker,
      db: {} as never,
      dbClient: { end: vi.fn(async () => undefined) },
      webhook: {
        webhookSecret: "webhook-secret",
        prSummaryBaseBranches: null,
        releaseConfig: null,
        findWebhookEventByDeliveryId: async () => false,
        insertWebhookEvent: async () => undefined,
        enqueueProcessPrJob: async () => undefined,
        enqueueProcessReleaseJob: async () => undefined,
      },
      registerSignalHandlers: true,
      startWorker: false,
    });

    expect(onceSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    onceSpy.mockRestore();
  });
});
