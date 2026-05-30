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

  it("should echo access-control-allow-origin on health when reflective CORS is enabled", async () => {
    const server = execute({ logger: false, cors: { kind: "reflect" } });
    servers.push(server);

    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:5173" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
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
    const enqueueProcessReleaseJob = async () => undefined;
    const enqueueProcessPushJob = async () => undefined;

    const server = execute({
      logger: false,
      webhook: {
        webhookSecret: secret,
        prSummaryBaseBranches: null,
        releaseConfig: null,
        findWebhookEventByDeliveryId,
        insertWebhookEvent,
        enqueueProcessPrJob,
        enqueueProcessReleaseJob,
        enqueueProcessPushJob,
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

  it("should return 401 for workspaces without bearer when workspaces api is enabled", async () => {
    const server = execute({
      logger: false,
      workspacesMe: {
        db: {} as never,
        jwtSecret: "x".repeat(32),
      },
    });
    servers.push(server);

    await server.ready();
    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces",
    });

    expect(response.statusCode).toBe(401);
  });

  it("should redirect to Google OAuth when google oauth input is provided", async () => {
    const server = execute({
      logger: false,
      googleOAuth: {
        db: {} as never,
        clientId: "test-google-client-id",
        clientSecret: "test-google-client-secret",
        jwtSecret: "x".repeat(32),
        publicApiUrl: "http://127.0.0.1:9",
        frontendUrl: "http://localhost:5173",
        nodeEnv: "test",
      },
    });
    servers.push(server);

    await server.ready();
    const response = await server.inject({
      method: "GET",
      url: "/auth/google/start",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(response.headers.location).toContain("client_id=test-google-client-id");
    expect(response.headers["set-cookie"]).toMatch(/driff_google_oauth_state=/);
  });
});
