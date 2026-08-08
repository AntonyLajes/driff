import { z } from "zod";

const repositoryFullNameSchema = z
  .string()
  .min(3)
  .max(241)
  .regex(/^[\w.-]+\/[\w.-]+$/u, "expected owner/repo");

const githubEventTypeSchema = z.enum(["pull_request", "push", "release"]);

const expectedJobTypeSchema = z.enum([
  "process_pr",
  "process_push",
  "process_release",
]);

const scenarioEventSchema = z.object({
  deliveryId: z.string().min(1).max(128),
  eventType: githubEventTypeSchema,
  offsetMs: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  expectedJobs: z.array(expectedJobTypeSchema).max(3).default([]),
});

const scenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "expected kebab-case scenario id"),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    repository: z.object({
      provider: z.literal("github"),
      fullName: repositoryFullNameSchema,
      defaultBranch: z.string().min(1).max(255),
    }),
    events: z.array(scenarioEventSchema).min(1).max(250),
  })
  .superRefine((scenario, context) => {
    const deliveryIds = new Set<string>();
    let previousOffset = -1;

    scenario.events.forEach((event, index) => {
      if (deliveryIds.has(event.deliveryId)) {
        context.addIssue({
          code: "custom",
          message: `duplicate deliveryId: ${event.deliveryId}`,
          path: ["events", index, "deliveryId"],
        });
      }
      deliveryIds.add(event.deliveryId);

      if (event.offsetMs < previousOffset) {
        context.addIssue({
          code: "custom",
          message: "events must be ordered by non-decreasing offsetMs",
          path: ["events", index, "offsetMs"],
        });
      }
      previousOffset = event.offsetMs;

      const repository = event.payload.repository;
      const payloadFullName =
        repository !== null &&
        typeof repository === "object" &&
        !Array.isArray(repository)
          ? (repository as Record<string, unknown>).full_name
          : undefined;

      if (payloadFullName !== scenario.repository.fullName) {
        context.addIssue({
          code: "custom",
          message: `payload repository must be ${scenario.repository.fullName}`,
          path: ["events", index, "payload", "repository", "full_name"],
        });
      }
    });
  });

export type DriffLabScenario = z.infer<typeof scenarioSchema>;

export const execute = (input: unknown): DriffLabScenario =>
  scenarioSchema.parse(input);
