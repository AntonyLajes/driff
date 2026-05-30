import { describe, expect, it } from "vitest";

import { buildProcessPushJobInput, type PushWebhookConfig } from "@/http/routes/webhook-push.js";

const basePayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ref: "refs/heads/main",
  before: "a".repeat(40),
  after: "b".repeat(40),
  repository: { full_name: "acme/app" },
  pusher: { name: "octocat" },
  head_commit: { timestamp: "2026-05-29T12:00:00Z" },
  ...overrides,
});

const config = (overrides: Partial<PushWebhookConfig> = {}): PushWebhookConfig => ({
  branches: [],
  defaultBranch: "main",
  monitoredRepo: null,
  ...overrides,
});

describe("http/routes/webhook-push buildProcessPushJobInput", () => {
  it("returns null when config is null", () => {
    expect(buildProcessPushJobInput("push", basePayload(), null)).toBeNull();
  });

  it("returns null when event type is not push", () => {
    expect(buildProcessPushJobInput("pull_request", basePayload(), config())).toBeNull();
  });

  it("enqueues a push to the default branch when no explicit branches are set", () => {
    const result = buildProcessPushJobInput("push", basePayload(), config());
    expect(result).toEqual({
      repo: "acme/app",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "main",
      pusher: "octocat",
      pushedAt: "2026-05-29T12:00:00Z",
    });
  });

  it("enqueues a push to a branch in the explicit list", () => {
    const payload = basePayload({ ref: "refs/heads/develop" });
    const result = buildProcessPushJobInput("push", payload, config({ branches: ["develop", "main"] }));
    expect(result?.branch).toBe("develop");
  });

  it("returns null when branch is not in the explicit list", () => {
    const payload = basePayload({ ref: "refs/heads/feature-x" });
    expect(
      buildProcessPushJobInput("push", payload, config({ branches: ["main"] })),
    ).toBeNull();
  });

  it("returns null when explicit branches are empty and there is no default branch", () => {
    expect(
      buildProcessPushJobInput("push", basePayload(), config({ defaultBranch: null })),
    ).toBeNull();
  });

  it("returns null for a null before/after sha (branch create or delete)", () => {
    expect(
      buildProcessPushJobInput("push", basePayload({ before: "0".repeat(40) }), config()),
    ).toBeNull();
    expect(
      buildProcessPushJobInput("push", basePayload({ after: "0".repeat(40) }), config()),
    ).toBeNull();
  });

  it("returns null when before equals after", () => {
    const sha = "c".repeat(40);
    expect(
      buildProcessPushJobInput("push", basePayload({ before: sha, after: sha }), config()),
    ).toBeNull();
  });

  it("returns null when the repo does not match the monitored repo", () => {
    expect(
      buildProcessPushJobInput("push", basePayload(), config({ monitoredRepo: "other/repo" })),
    ).toBeNull();
  });

  it("returns null pusher and pushedAt when absent from the payload", () => {
    const payload = basePayload({ pusher: undefined, head_commit: null });
    const result = buildProcessPushJobInput("push", payload, config());
    expect(result?.pusher).toBeNull();
    expect(result?.pushedAt).toBeNull();
  });
});
