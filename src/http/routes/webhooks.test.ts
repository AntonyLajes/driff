import { createHmac } from "node:crypto";

import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handler } from "@/http/routes/webhooks.js";

const buildSignature = (payload: string, secret: string): string => {
  const hash = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hash}`;
};

describe("http/routes/webhooks handler", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  const setup = async () => {
    const findWebhookEventByDeliveryId = vi.fn(async () => false);
    const insertWebhookEvent = vi.fn(async () => undefined);
    const enqueueProcessPrJob = vi.fn(async () => undefined);
    const enqueueProcessReleaseJob = vi.fn(async () => undefined);
    const secret = "webhook-secret";
    const server = fastify({ logger: false });
    servers.push(server);

    server.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        done(null, body);
      },
    );

    await handler(server, {
      webhookSecret: secret,
      prSummaryBaseBranches: null,
      releaseConfig: null,
      findWebhookEventByDeliveryId,
      insertWebhookEvent,
      enqueueProcessPrJob,
      enqueueProcessReleaseJob,
    });
    await server.ready();

    return {
      enqueueProcessPrJob,
      enqueueProcessReleaseJob,
      findWebhookEventByDeliveryId,
      insertWebhookEvent,
      secret,
      server,
    };
  };

  it("should return 400 when required headers are missing", async () => {
    const { server } = await setup();

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: "{}",
      headers: {
        "content-type": "application/json",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should return 401 when signature is invalid", async () => {
    const { server } = await setup();
    const payload = JSON.stringify({ action: "opened" });

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=invalid",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should return 400 when payload is invalid json", async () => {
    const { secret, server } = await setup();
    const payload = "{invalid-json";

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-invalid-json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": buildSignature(payload, secret),
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should return 200 duplicate when delivery id already exists", async () => {
    const {
      findWebhookEventByDeliveryId,
      insertWebhookEvent,
      enqueueProcessPrJob,
      secret,
      server,
    } = await setup();
    findWebhookEventByDeliveryId.mockResolvedValueOnce(true);
    const payload = JSON.stringify({ action: "opened" });

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": buildSignature(payload, secret),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, duplicate: true });
    expect(insertWebhookEvent).not.toHaveBeenCalled();
    expect(enqueueProcessPrJob).not.toHaveBeenCalled();
  });

  it("should persist event and enqueue process_pr when merged pull request closes", async () => {
    const { enqueueProcessPrJob, insertWebhookEvent, secret, server } = await setup();
    const payload = JSON.stringify({
      action: "closed",
      pull_request: {
        merged: true,
        number: 42,
        base: { ref: "main" },
      },
      repository: {
        full_name: "acme/mobile-app",
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-merged",
        "x-github-event": "pull_request",
        "x-hub-signature-256": buildSignature(payload, secret),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(insertWebhookEvent).toHaveBeenCalledOnce();
    expect(enqueueProcessPrJob).toHaveBeenCalledWith({
      repo: "acme/mobile-app",
      prNumber: 42,
    });
  });

  it("should persist event without enqueue when event does not match merged pr", async () => {
    const { enqueueProcessPrJob, insertWebhookEvent, secret, server } = await setup();
    const payload = JSON.stringify({
      action: "opened",
      repository: {
        full_name: "acme/mobile-app",
      },
      pull_request: {
        merged: false,
        number: 50,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-opened",
        "x-github-event": "pull_request",
        "x-hub-signature-256": buildSignature(payload, secret),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(insertWebhookEvent).toHaveBeenCalledOnce();
    expect(enqueueProcessPrJob).not.toHaveBeenCalled();
  });

  it("should persist event but skip process_pr when base branch is not in allow list", async () => {
    const secret = "webhook-secret";
    const serverWithFilter = fastify({ logger: false });
    servers.push(serverWithFilter);
    serverWithFilter.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        done(null, body);
      },
    );
    const findWebhookEventByDeliveryId = vi.fn(async () => false);
    const insertWebhookEventForFilter = vi.fn(async () => undefined);
    const enqueueProcessPrJobForFilter = vi.fn(async () => undefined);
    await handler(serverWithFilter, {
      webhookSecret: secret,
      prSummaryBaseBranches: ["develop"],
      releaseConfig: null,
      findWebhookEventByDeliveryId,
      insertWebhookEvent: insertWebhookEventForFilter,
      enqueueProcessPrJob: enqueueProcessPrJobForFilter,
      enqueueProcessReleaseJob: vi.fn(async () => undefined),
    });
    await serverWithFilter.ready();

    const payload = JSON.stringify({
      action: "closed",
      pull_request: {
        merged: true,
        number: 99,
        base: { ref: "main" },
      },
      repository: {
        full_name: "acme/mobile-app",
      },
    });

    const response = await serverWithFilter.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-wrong-branch",
        "x-github-event": "pull_request",
        "x-hub-signature-256": buildSignature(payload, secret),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(insertWebhookEventForFilter).toHaveBeenCalledOnce();
    expect(enqueueProcessPrJobForFilter).not.toHaveBeenCalled();
  });

  it("should enqueue process_pr when base branch is in allow list", async () => {
    const secret = "webhook-secret";
    const serverWithFilter = fastify({ logger: false });
    servers.push(serverWithFilter);
    serverWithFilter.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        done(null, body);
      },
    );
    const findWebhookEventByDeliveryId = vi.fn(async () => false);
    const insertWebhookEventForFilter = vi.fn(async () => undefined);
    const enqueueProcessPrJobForFilter = vi.fn(async () => undefined);
    await handler(serverWithFilter, {
      webhookSecret: secret,
      prSummaryBaseBranches: ["develop", "release"],
      releaseConfig: null,
      findWebhookEventByDeliveryId,
      insertWebhookEvent: insertWebhookEventForFilter,
      enqueueProcessPrJob: enqueueProcessPrJobForFilter,
      enqueueProcessReleaseJob: vi.fn(async () => undefined),
    });
    await serverWithFilter.ready();

    const payload = JSON.stringify({
      action: "closed",
      pull_request: {
        merged: true,
        number: 100,
        base: { ref: "develop" },
      },
      repository: {
        full_name: "acme/mobile-app",
      },
    });

    const response = await serverWithFilter.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-develop",
        "x-github-event": "pull_request",
        "x-hub-signature-256": buildSignature(payload, secret),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(insertWebhookEventForFilter).toHaveBeenCalledOnce();
    expect(enqueueProcessPrJobForFilter).toHaveBeenCalledWith({
      repo: "acme/mobile-app",
      prNumber: 100,
    });
  });

  it("should enqueue process_release on push when releaseConfig matches", async () => {
    const secret = "webhook-secret";
    const serverPush = fastify({ logger: false });
    servers.push(serverPush);
    serverPush.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        done(null, body);
      },
    );
    const enqueueProcessReleaseJob = vi.fn(async () => undefined);
    await handler(serverPush, {
      webhookSecret: secret,
      prSummaryBaseBranches: null,
      releaseConfig: {
        branch: "develop",
        versionWatchPaths: ["App/Info.plist"],
        monitoredRepo: null,
      },
      findWebhookEventByDeliveryId: vi.fn(async () => false),
      insertWebhookEvent: vi.fn(async () => undefined),
      enqueueProcessPrJob: vi.fn(async () => undefined),
      enqueueProcessReleaseJob,
    });
    await serverPush.ready();
    const payload = JSON.stringify({
      ref: "refs/heads/develop",
      before: "a".repeat(40),
      after: "b".repeat(40),
      repository: { full_name: "acme/ios" },
      commits: [{ modified: ["App/Info.plist"] }],
    });
    const response = await serverPush.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-push-rel",
        "x-github-event": "push",
        "x-hub-signature-256": buildSignature(payload, secret),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(enqueueProcessReleaseJob).toHaveBeenCalledWith({
      repo: "acme/ios",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });
  });
});
