import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client.js";
import { execute } from "@/http/routes/webhooks-dependencies.js";

const buildDbMock = (foundRows: Array<{ id: string }>) => {
  const limit = vi.fn(async () => foundRows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const values = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values }));

  const db = {
    select,
    insert,
  } as unknown as Database;

  return { db, insert, limit, select, values };
};

describe("http/routes/webhooks-dependencies execute", () => {
  it("should return true when delivery id exists", async () => {
    const { db } = buildDbMock([{ id: "event-id" }]);
    const dependencies = execute({ db });

    const found = await dependencies.findWebhookEventByDeliveryId("delivery-1");

    expect(found).toBe(true);
  });

  it("should return false when delivery id does not exist", async () => {
    const { db } = buildDbMock([]);
    const dependencies = execute({ db });

    const found = await dependencies.findWebhookEventByDeliveryId("delivery-1");

    expect(found).toBe(false);
  });

  it("should insert webhook event", async () => {
    const { db, insert } = buildDbMock([]);
    const dependencies = execute({ db });

    await dependencies.insertWebhookEvent({
      deliveryId: "delivery-2",
      eventType: "pull_request",
      payload: { foo: "bar" },
    });

    expect(insert).toHaveBeenCalledOnce();
  });

  it("should enqueue process_pr job as pending", async () => {
    const { db, insert, values } = buildDbMock([]);
    const dependencies = execute({ db });

    await dependencies.enqueueProcessPrJob({
      repo: "acme/mobile-app",
      prNumber: 99,
    });

    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "process_pr",
        status: "pending",
        payload: { repo: "acme/mobile-app", prNumber: 99 },
      }),
    );
  });

  it("should enqueue process_release job as pending", async () => {
    const { db, insert, values } = buildDbMock([]);
    const dependencies = execute({ db });

    await dependencies.enqueueProcessReleaseJob({
      repo: "acme/ios",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });

    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "process_release",
        status: "pending",
        payload: {
          repo: "acme/ios",
          beforeSha: "a".repeat(40),
          afterSha: "b".repeat(40),
          branch: "develop",
        },
      }),
    );
  });

  it("should correlate every job type with its webhook delivery", async () => {
    const { db, values } = buildDbMock([]);
    const dependencies = execute({ db });

    await dependencies.enqueueProcessPrJob({
      repo: "acme/app",
      prNumber: 7,
      deliveryId: "delivery-pr",
    });
    await dependencies.enqueueProcessReleaseJob({
      repo: "acme/app",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "main",
      deliveryId: "delivery-release",
    });
    await dependencies.enqueueProcessPushJob({
      repo: "acme/app",
      beforeSha: "b".repeat(40),
      afterSha: "c".repeat(40),
      branch: "main",
      pusher: "octocat",
      pushedAt: "2026-08-09T12:00:00Z",
      deliveryId: "delivery-push",
    });

    expect(values).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        payload: {
          repo: "acme/app",
          prNumber: 7,
          deliveryId: "delivery-pr",
        },
      }),
    );
    expect(values).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: expect.objectContaining({ deliveryId: "delivery-release" }),
      }),
    );
    expect(values).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        payload: expect.objectContaining({ deliveryId: "delivery-push" }),
      }),
    );
  });

  it("should enqueue an uncorrelated push for backward compatibility", async () => {
    const { db, values } = buildDbMock([]);
    const dependencies = execute({ db });

    await dependencies.enqueueProcessPushJob({
      repo: "acme/app",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "main",
      pusher: null,
      pushedAt: null,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.not.objectContaining({ deliveryId: expect.anything() }),
      }),
    );
  });
});
