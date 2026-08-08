import { z } from "zod";

import {
  execute as parseScenario,
  type DriffLabScenario,
} from "@/lab/scenario.js";

const runIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "expected kebab-case run id");

export interface ExecuteInput {
  scenario: unknown;
  runId?: string;
}

export const execute = ({
  scenario: input,
  runId,
}: ExecuteInput): DriffLabScenario => {
  const scenario = parseScenario(input);
  if (runId === undefined) {
    return scenario;
  }

  const parsedRunId = runIdSchema.parse(runId);
  return parseScenario({
    ...scenario,
    events: scenario.events.map((event) => ({
      ...event,
      deliveryId: `${event.deliveryId}--${parsedRunId}`,
    })),
  });
};
