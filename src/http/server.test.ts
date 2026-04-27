import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { execute } from "@/http/server.js";

describe("http/server execute", () => {
  const servers: ReturnType<typeof execute>[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("should expose health route on created server", async () => {
    const server = execute({ logger: false });
    servers.push(server);

    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("should create a server when logger is inferred in test environment", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "test";

      const server = execute();
      servers.push(server);

      await server.ready();
      const response = await server.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("should create a server when logger is inferred outside test environment", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousLogLevel = process.env.LOG_LEVEL;
    try {
      process.env.NODE_ENV = "production";
      process.env.LOG_LEVEL = "debug";

      const server = execute();
      servers.push(server);

      await server.ready();
      const response = await server.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      process.env.LOG_LEVEL = previousLogLevel;
    }
  });

  it("should expose github webhook route when webhook dependencies are provided", async () => {
    const secret = "webhook-secret";
    const payload = JSON.stringify({
      action: "closed",
      repository: { full_name: "acme/mobile-app" },
      pull_request: { merged: true, number: 7, base: { ref: "main" } },
    });
    const signature =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    const findWebhookEventByDeliveryId = async () => false;
    const insertWebhookEvent = async () => undefined;
    const enqueueProcessPrJob = async () => undefined;

    const server = execute({
      logger: false,
      webhook: {
        webhookSecret: secret,
        prSummaryBaseBranches: null,
        findWebhookEventByDeliveryId,
        insertWebhookEvent,
        enqueueProcessPrJob,
      },
    });
    servers.push(server);

    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-server-test",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
