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
}

export interface WebhookDependencies {
  findWebhookEventByDeliveryId: (deliveryId: string) => Promise<boolean>;
  insertWebhookEvent: (input: WebhookEventInput) => Promise<void>;
  enqueueProcessPrJob: (input: ProcessPrJobInput) => Promise<void>;
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
    enqueueProcessPrJob: async ({ repo, prNumber }) => {
      await db.insert(jobsTable).values({
        type: "process_pr",
        payload: { repo, prNumber },
        status: "pending",
      });
    },
  };
};
