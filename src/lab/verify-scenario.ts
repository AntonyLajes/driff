import { createHmac } from "node:crypto";

import { execute as createServer } from "@/http/server.js";
import { execute as parseScenario } from "@/lab/scenario.js";

const WEBHOOK_SECRET = "driff-lab-in-memory-secret";

export interface VerificationSummary {
  scenarioId: string;
  eventCount: number;
  expectedJobCount: number;
}

const signatureFor = (body: string): string =>
  `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;

const sameJobs = (
  actual: readonly string[],
  expected: readonly string[],
): boolean =>
  actual.length === expected.length &&
  actual.every((job, index) => job === expected[index]);

export const execute = async (input: unknown): Promise<VerificationSummary> => {
  const scenario = parseScenario(input);
  let currentJobs: string[] = [];

  const server = createServer({
    logger: false,
    webhook: {
      webhookSecret: WEBHOOK_SECRET,
      resolveWebhookSettings: async (repoFullName) => {
        if (repoFullName !== scenario.repository.fullName) {
          return null;
        }
        const settings = scenario.webhookSettings;
        return {
          prSummaryBaseBranches: settings.prSummaryBaseBranches,
          releaseConfig:
            settings.release === null
              ? null
              : {
                  branch: settings.release.branch,
                  versionWatchPaths: settings.release.versionWatchPaths,
                  monitoredRepo: scenario.repository.fullName,
                },
          pushConfig:
            settings.push === null
              ? null
              : {
                  branches: settings.push.branches,
                  defaultBranch: scenario.repository.defaultBranch,
                  monitoredRepo: scenario.repository.fullName,
                },
        };
      },
      findWebhookEventByDeliveryId: async () => false,
      insertWebhookEvent: async () => undefined,
      enqueueProcessPrJob: async () => {
        currentJobs.push("process_pr");
      },
      enqueueProcessReleaseJob: async () => {
        currentJobs.push("process_release");
      },
      enqueueProcessPushJob: async () => {
        currentJobs.push("process_push");
      },
    },
  });

  let expectedJobCount = 0;
  try {
    await server.ready();
    for (const event of scenario.events) {
      currentJobs = [];
      const body = JSON.stringify(event.payload);
      const response = await server.inject({
        method: "POST",
        url: "/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": event.deliveryId,
          "x-github-event": event.eventType,
          "x-hub-signature-256": signatureFor(body),
        },
        payload: body,
      });

      if (response.statusCode !== 200) {
        throw new Error(
          `Scenario ${scenario.id} event ${event.deliveryId} returned HTTP ${response.statusCode}.`,
        );
      }
      if (!sameJobs(currentJobs, event.expectedJobs)) {
        throw new Error(
          `Scenario ${scenario.id} event ${event.deliveryId} expected jobs [${event.expectedJobs.join(
            ", ",
          )}] but enqueued [${currentJobs.join(", ")}].`,
        );
      }
      expectedJobCount += event.expectedJobs.length;
    }
  } finally {
    await server.close();
  }

  return {
    scenarioId: scenario.id,
    eventCount: scenario.events.length,
    expectedJobCount,
  };
};
