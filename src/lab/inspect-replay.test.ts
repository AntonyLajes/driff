import { describe, expect, it, vi } from "vitest";

import { execute } from "@/lab/inspect-replay.js";

const scenario = {
  schemaVersion: 1,
  id: "status-check",
  name: "Status check",
  description: "Checks correlated webhook jobs.",
  repository: { provider: "github", fullName: "acme/app", defaultBranch: "main" },
  webhookSettings: { prSummaryBaseBranches: ["main"], release: null, push: null },
  events: [
    {
      deliveryId: "delivery-1",
      eventType: "pull_request",
      offsetMs: 0,
      payload: { repository: { full_name: "acme/app" } },
      expectedJobs: ["process_pr"],
    },
  ],
};

describe("lab/inspect-replay", () => {
  it("reports a correlated completed run", async () => {
    const result = await execute({
      scenario,
      runId: "nightly-1",
      store: {
        hasWebhook: vi.fn(async (id) => id === "delivery-1--nightly-1"),
        findJobs: vi.fn(async () => [
          { type: "process_pr", status: "done", attempts: 1, lastError: null },
        ]),
      },
    });

    expect(result.status).toBe("passed");
    expect(result.events[0]).toMatchObject({
      deliveryId: "delivery-1--nightly-1",
      status: "passed",
    });
  });

  it("distinguishes missing, pending and failed work", async () => {
    const missing = await execute({
      scenario,
      store: {
        hasWebhook: async () => false,
        findJobs: async () => [],
      },
    });
    expect(missing.status).toBe("not_received");

    const pending = await execute({
      scenario,
      store: {
        hasWebhook: async () => true,
        findJobs: async () => [
          { type: "process_pr", status: "running", attempts: 1, lastError: null },
        ],
      },
    });
    expect(pending.status).toBe("pending");

    const failed = await execute({
      scenario,
      store: {
        hasWebhook: async () => true,
        findJobs: async () => [
          { type: "process_pr", status: "failed", attempts: 3, lastError: "boom" },
        ],
      },
    });
    expect(failed.status).toBe("failed");
  });

  it("passes a received event that intentionally enqueues no jobs", async () => {
    const noJobScenario = {
      ...scenario,
      events: [{ ...scenario.events[0], expectedJobs: [] }],
    };
    const result = await execute({
      scenario: noJobScenario,
      store: {
        hasWebhook: async () => true,
        findJobs: async () => [],
      },
    });

    expect(result.status).toBe("passed");
  });
});
