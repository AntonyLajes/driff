import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listen = vi.fn(async () => "http://0.0.0.0:3000");
  const server = { listen };
  const createServer = vi.fn(() => server);
  const createDbClient = vi.fn(() => ({ db: { fake: true } }));
  const createWebhookDependencies = vi.fn(() => ({
    findWebhookEventByDeliveryId: async () => false,
    insertWebhookEvent: async () => undefined,
    enqueueProcessPrJob: async () => undefined,
  }));

  return {
    createDbClient,
    createServer,
    createWebhookDependencies,
    listen,
    server,
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

import { execute } from "@/index.js";

describe("index execute runtime wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listen.mockResolvedValue("http://0.0.0.0:3000");
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.DATABASE_URL;
  });

  it("should create server without webhook when env vars are missing", async () => {
    await execute();

    expect(mocks.createServer).toHaveBeenCalledWith({ webhook: undefined });
    expect(mocks.createDbClient).not.toHaveBeenCalled();
    expect(mocks.createWebhookDependencies).not.toHaveBeenCalled();
  });

  it("should create webhook dependencies when env vars are available", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/driff";

    await execute();

    expect(mocks.createDbClient).toHaveBeenCalledWith({
      databaseUrl: "postgres://user:pass@localhost:5432/driff",
    });
    expect(mocks.createWebhookDependencies).toHaveBeenCalledOnce();
    expect(mocks.createServer).toHaveBeenCalledWith({
      webhook: expect.objectContaining({
        webhookSecret: "webhook-secret",
      }),
    });
  });
});
