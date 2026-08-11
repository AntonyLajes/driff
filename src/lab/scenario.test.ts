import { describe, expect, it } from "vitest";

import { execute } from "@/lab/scenario.js";

const validScenario = () => ({
  schemaVersion: 1 as const,
  id: "web-release-history",
  name: "Web release history",
  description: "One deterministic merged pull request.",
  repository: {
    provider: "github" as const,
    fullName: "driff-lab/web-app",
    defaultBranch: "main",
  },
  events: [
    {
      deliveryId: "lab-web-pr-1",
      eventType: "pull_request" as const,
      offsetMs: 0,
      payload: {
        repository: { full_name: "driff-lab/web-app" },
      },
      expectedJobs: ["process_pr" as const],
    },
  ],
});

describe("lab/scenario", () => {
  it("should parse a deterministic scenario when every boundary is valid", () => {
    const scenario = execute(validScenario());

    expect(scenario.id).toBe("web-release-history");
    expect(scenario.events).toHaveLength(1);
    expect(scenario.events[0]?.expectedJobs).toEqual(["process_pr"]);
  });

  it("should default expected jobs when an event has no expectation", () => {
    const input = validScenario();
    const event = input.events[0];
    if (event === undefined) {
      throw new Error("Expected fixture event.");
    }
    const { expectedJobs: _expectedJobs, ...eventWithoutExpectation } = event;

    const scenario = execute({ ...input, events: [eventWithoutExpectation] });

    expect(scenario.events[0]?.expectedJobs).toEqual([]);
  });

  it("should reject duplicate delivery ids", () => {
    const input = validScenario();
    const event = input.events[0];
    if (event === undefined) {
      throw new Error("Expected fixture event.");
    }

    expect(() =>
      execute({
        ...input,
        events: [event, { ...event, offsetMs: 1000 }],
      }),
    ).toThrow(/duplicate deliveryId/u);
  });

  it("should reject events that are not ordered by offset", () => {
    const input = validScenario();
    const event = input.events[0];
    if (event === undefined) {
      throw new Error("Expected fixture event.");
    }

    expect(() =>
      execute({
        ...input,
        events: [
          { ...event, deliveryId: "later", offsetMs: 1000 },
          { ...event, deliveryId: "earlier", offsetMs: 500 },
        ],
      }),
    ).toThrow(/non-decreasing offsetMs/u);
  });

  it("should reject an event payload from another repository", () => {
    const input = validScenario();
    const event = input.events[0];
    if (event === undefined) {
      throw new Error("Expected fixture event.");
    }

    expect(() =>
      execute({
        ...input,
        events: [
          {
            ...event,
            payload: { repository: { full_name: "other/repository" } },
          },
        ],
      }),
    ).toThrow(/payload repository must be driff-lab\/web-app/u);
  });

  it("should reject unsupported schema and event versions", () => {
    expect(() => execute({ ...validScenario(), schemaVersion: 2 })).toThrow();
    expect(() =>
      execute({
        ...validScenario(),
        events: [
          {
            ...validScenario().events[0],
            eventType: "deployment",
          },
        ],
      }),
    ).toThrow();
  });
});
