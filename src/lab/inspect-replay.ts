import { execute as materializeScenario } from "@/lab/materialize-scenario.js";

export interface LabReplayJob {
  type: string;
  status: string;
  attempts: number;
  lastError: string | null;
}

export interface LabStatusStore {
  hasWebhook: (deliveryId: string) => Promise<boolean>;
  findJobs: (deliveryId: string) => Promise<LabReplayJob[]>;
}

export type LabEventStatus = "not_received" | "pending" | "passed" | "failed";

export interface LabReplayStatus {
  scenarioId: string;
  status: LabEventStatus;
  events: Array<{
    deliveryId: string;
    expectedJobs: string[];
    jobs: LabReplayJob[];
    status: LabEventStatus;
  }>;
}

const eventStatus = (
  received: boolean,
  expectedJobs: readonly string[],
  jobs: readonly LabReplayJob[],
): LabEventStatus => {
  if (!received) return "not_received";
  if (jobs.some((job) => job.status === "failed")) return "failed";

  const completedTypes = new Set(
    jobs.filter((job) => job.status === "done").map((job) => job.type),
  );
  if (expectedJobs.every((type) => completedTypes.has(type))) return "passed";
  return "pending";
};

const aggregateStatus = (statuses: readonly LabEventStatus[]): LabEventStatus => {
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "not_received")) return "not_received";
  if (statuses.some((status) => status === "pending")) return "pending";
  return "passed";
};

export const execute = async (input: {
  scenario: unknown;
  runId?: string;
  store: LabStatusStore;
}): Promise<LabReplayStatus> => {
  const scenario = materializeScenario({
    scenario: input.scenario,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
  const events = await Promise.all(
    scenario.events.map(async (event) => {
      const [received, jobs] = await Promise.all([
        input.store.hasWebhook(event.deliveryId),
        input.store.findJobs(event.deliveryId),
      ]);
      return {
        deliveryId: event.deliveryId,
        expectedJobs: event.expectedJobs,
        jobs,
        status: eventStatus(received, event.expectedJobs, jobs),
      };
    }),
  );

  return {
    scenarioId: scenario.id,
    status: aggregateStatus(events.map((event) => event.status)),
    events,
  };
};
