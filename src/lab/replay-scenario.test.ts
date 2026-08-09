import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { execute, type ReplayFetch } from "@/lab/replay-scenario.js";

const scenario = () => ({
  schemaVersion: 1 as const,
  id: "two-events",
  name: "Two events",
  description: "Two ordered GitHub events for replay tests.",
  repository: {
    provider: "github" as const,
    fullName: "driff-lab/web-app",
    defaultBranch: "main",
  },
  events: [
    {
      deliveryId: "delivery-1",
      eventType: "pull_request" as const,
      offsetMs: 0,
      payload: {
        repository: { full_name: "driff-lab/web-app" },
        action: "closed",
      },
      expectedJobs: ["process_pr" as const],
    },
    {
      deliveryId: "delivery-2",
      eventType: "push" as const,
      offsetMs: 750,
      payload: {
        repository: { full_name: "driff-lab/web-app" },
        ref: "refs/heads/main",
      },
      expectedJobs: ["process_push" as const],
    },
  ],
});

const acceptedResponse = () => ({
  ok: true,
  status: 200,
  text: async () => '{"ok":true}',
});

describe("lab/replay-scenario", () => {
  it("should sign and replay ordered events against localhost", async () => {
    const requests: Array<Parameters<ReplayFetch>> = [];
    const delays: number[] = [];
    const fetcher: ReplayFetch = async (...request) => {
      requests.push(request);
      return acceptedResponse();
    };

    const result = await execute({
      scenario: scenario(),
      targetUrl: "http://localhost:3000/webhooks/github",
      webhookSecret: "lab-secret",
      fetcher,
      sleeper: async (durationMs) => {
        delays.push(durationMs);
      },
    });

    expect(result).toEqual({
      scenarioId: "two-events",
      events: [
        { deliveryId: "delivery-1", eventType: "pull_request", status: 200 },
        { deliveryId: "delivery-2", eventType: "push", status: 200 },
      ],
    });
    expect(delays).toEqual([750]);
    expect(requests).toHaveLength(2);

    const firstRequest = requests[0];
    if (firstRequest === undefined) {
      throw new Error("Expected first replay request.");
    }
    const [url, init] = firstRequest;
    const expectedSignature = `sha256=${createHmac("sha256", "lab-secret")
      .update(init.body)
      .digest("hex")}`;
    expect(url).toBe("http://localhost:3000/webhooks/github");
    expect(init.headers).toMatchObject({
      "x-github-delivery": "delivery-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": expectedSignature,
    });
  });

  it("should require confirmation and an allowlist for remote hosts", async () => {
    const input = {
      scenario: scenario(),
      targetUrl: "https://driff-development.example/webhooks/github",
      webhookSecret: "lab-secret",
      fetcher: async () => acceptedResponse(),
      sleeper: async () => undefined,
    } satisfies Parameters<typeof execute>[0];

    await expect(execute(input)).rejects.toThrow(/confirm-development/u);
    await expect(
      execute({ ...input, confirmDevelopment: true }),
    ).rejects.toThrow(/not allowlisted/u);
    await expect(
      execute({
        ...input,
        confirmDevelopment: true,
        allowedRemoteHosts: [" DRIFF-DEVELOPMENT.EXAMPLE "],
      }),
    ).resolves.toMatchObject({ scenarioId: "two-events" });
  });

  it("should reject unsafe or incorrect targets", async () => {
    const base = {
      scenario: scenario(),
      webhookSecret: "lab-secret",
      fetcher: async () => acceptedResponse(),
      sleeper: async () => undefined,
    } satisfies Omit<Parameters<typeof execute>[0], "targetUrl">;

    await expect(
      execute({ ...base, targetUrl: "ftp://localhost/webhooks/github" }),
    ).rejects.toThrow(/http or https/u);
    await expect(
      execute({
        ...base,
        targetUrl: "http://user:pass@localhost/webhooks/github",
      }),
    ).rejects.toThrow(/credentials/u);
    await expect(
      execute({ ...base, targetUrl: "http://localhost/health" }),
    ).rejects.toThrow(/exact \/webhooks\/github/u);
    await expect(
      execute({
        ...base,
        targetUrl: "http://localhost/webhooks/github?force=true",
      }),
    ).rejects.toThrow(/exact \/webhooks\/github/u);
  });

  it("should reject an empty webhook secret before sending", async () => {
    await expect(
      execute({
        scenario: scenario(),
        targetUrl: "http://localhost/webhooks/github",
        webhookSecret: "   ",
      }),
    ).rejects.toThrow(/non-empty GitHub webhook secret/u);
  });

  it("should stop and report a rejected webhook response", async () => {
    let requestCount = 0;

    await expect(
      execute({
        scenario: scenario(),
        targetUrl: "http://localhost/webhooks/github",
        webhookSecret: "lab-secret",
        fetcher: async () => {
          requestCount += 1;
          return {
            ok: false,
            status: 401,
            text: async () => "invalid signature",
          };
        },
        sleeper: async () => undefined,
      }),
    ).rejects.toThrow(/delivery-1 failed with HTTP 401: invalid signature/u);
    expect(requestCount).toBe(1);
  });

  it("should preserve the cause when the network request fails", async () => {
    const cause = new Error("connection refused");

    await expect(
      execute({
        scenario: scenario(),
        targetUrl: "http://localhost/webhooks/github",
        webhookSecret: "lab-secret",
        fetcher: async () => {
          throw cause;
        },
        sleeper: async () => undefined,
      }),
    ).rejects.toMatchObject({
      message: "Driff Lab request failed for delivery-1. connection refused",
      cause,
    });
  });
});
