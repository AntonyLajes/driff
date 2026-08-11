import { describe, expect, it } from "vitest";

import { execute } from "@/lab/materialize-scenario.js";

const scenario = () => ({
  schemaVersion: 1 as const,
  id: "single-event",
  name: "Single event",
  description: "A scenario used to materialize replay run IDs.",
  repository: {
    provider: "github" as const,
    fullName: "driff-lab/web-app",
    defaultBranch: "main",
  },
  events: [
    {
      deliveryId: "delivery-1",
      eventType: "push" as const,
      offsetMs: 0,
      payload: { repository: { full_name: "driff-lab/web-app" } },
      expectedJobs: ["process_push" as const],
    },
  ],
});

describe("lab/materialize-scenario", () => {
  it("should preserve deterministic delivery IDs when no run ID is provided", () => {
    expect(execute({ scenario: scenario() }).events[0]?.deliveryId).toBe(
      "delivery-1",
    );
  });

  it("should derive fresh delivery IDs from a valid run ID", () => {
    expect(
      execute({ scenario: scenario(), runId: "railway-dev-42" }).events[0]
        ?.deliveryId,
    ).toBe("delivery-1--railway-dev-42");
  });

  it("should reject unsafe run IDs and delivery IDs that become too long", () => {
    expect(() =>
      execute({ scenario: scenario(), runId: "Production RUN" }),
    ).toThrow(/kebab-case run id/u);
    expect(() =>
      execute({
        scenario: {
          ...scenario(),
          events: [
            {
              ...scenario().events[0],
              deliveryId: "a".repeat(120),
            },
          ],
        },
        runId: "too-long",
      }),
    ).toThrow();
  });
});
