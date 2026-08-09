import { eq } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { jobsTable, webhookEventsTable } from "@/db/schema.js";

export interface ExecuteInput {
  db: Database;
}

export interface WebhookEventInput {
  deliveryId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface ProcessPrJobInput {
  repo: string;
  prNumber: number;
  deliveryId?: string;
}

export interface ProcessReleaseJobInput {
  repo: string;
  beforeSha: string;
  afterSha: string;
  branch: string;
  tagName?: string;
  sourceUrl?: string;
  releasedAt?: string;
  deliveryId?: string;
}

export interface ProcessPushJobInput {
  repo: string;
  beforeSha: string;
  afterSha: string;
  branch: string;
  pusher: string | null;
  pushedAt: string | null;
  deliveryId?: string;
}

export interface WebhookDependencies {
  findWebhookEventByDeliveryId: (deliveryId: string) => Promise<boolean>;
  insertWebhookEvent: (input: WebhookEventInput) => Promise<void>;
  enqueueProcessPrJob: (input: ProcessPrJobInput) => Promise<void>;
  enqueueProcessReleaseJob: (input: ProcessReleaseJobInput) => Promise<void>;
  enqueueProcessPushJob: (input: ProcessPushJobInput) => Promise<void>;
}

export const execute = ({ db }: ExecuteInput): WebhookDependencies => {
  return {
    findWebhookEventByDeliveryId: async (deliveryId) => {
      const result = await db
        .select({ id: webhookEventsTable.id })
        .from(webhookEventsTable)
        .where(eq(webhookEventsTable.deliveryId, deliveryId))
        .limit(1);

      return result.length > 0;
    },
    insertWebhookEvent: async ({ deliveryId, eventType, payload }) => {
      await db.insert(webhookEventsTable).values({
        deliveryId,
        eventType,
        payload,
      });
    },
    enqueueProcessPrJob: async ({ repo, prNumber, deliveryId }) => {
      await db.insert(jobsTable).values({
        type: "process_pr",
        payload: { repo, prNumber, ...(deliveryId ? { deliveryId } : {}) },
        status: "pending",
      });
    },
    enqueueProcessReleaseJob: async ({
      repo,
      beforeSha,
      afterSha,
      branch,
      tagName,
      sourceUrl,
      releasedAt,
      deliveryId,
    }) => {
      await db.insert(jobsTable).values({
        type: "process_release",
        payload: {
          repo,
          beforeSha,
          afterSha,
          branch,
          ...(tagName ? { tagName } : {}),
          ...(sourceUrl ? { sourceUrl } : {}),
          ...(releasedAt ? { releasedAt } : {}),
          ...(deliveryId ? { deliveryId } : {}),
        },
        status: "pending",
      });
    },
    enqueueProcessPushJob: async ({
      repo,
      beforeSha,
      afterSha,
      branch,
      pusher,
      pushedAt,
      deliveryId,
    }) => {
      await db.insert(jobsTable).values({
        type: "process_push",
        payload: {
          repo,
          beforeSha,
          afterSha,
          branch,
          pusher,
          pushedAt,
          ...(deliveryId ? { deliveryId } : {}),
        },
        status: "pending",
      });
    },
  };
};
