import { z } from "zod";

const evidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  sourceKey: z.string().min(1),
  externalId: z.string().nullable(),
  url: z.string().url().nullable(),
  sha: z.string().nullable(),
  path: z.string().nullable(),
  occurredAt: z.string().datetime({ offset: true }),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

const changeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summaryExecutive: z.string().nullable(),
  summaryTechnical: z.string().nullable(),
  category: z.string().min(1),
  confidence: z.number().int().min(0).max(100).nullable(),
  firstOccurredAt: z.string().datetime({ offset: true }),
  lastOccurredAt: z.string().datetime({ offset: true }),
  areas: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      slug: z.string().min(1),
      confidence: z.number().int().min(0).max(100).nullable(),
      source: z.string().min(1),
    }),
  ),
  contributors: z.array(
    z.object({
      externalIdentity: z.string().min(1),
      displayName: z.string().nullable(),
      role: z.string().min(1),
      sourceUrl: z.string().url().nullable(),
    }),
  ),
  evidence: z.array(evidenceSchema),
});

const versionSchema = z.object({
  id: z.string().min(1),
  displayVersion: z.string().min(1),
  normalizedVersion: z.string().min(1),
  buildVersion: z.string().nullable(),
  title: z.string().nullable(),
  changelog: z.string().nullable(),
  sections: z
    .array(z.object({ label: z.string(), items: z.array(z.string()) }))
    .nullable(),
  sourceUrl: z.string().url().nullable(),
  previousVersionId: z.string().nullable(),
  beforeSha: z.string().nullable(),
  headSha: z.string().nullable(),
  releasedAt: z.string().datetime({ offset: true }).nullable(),
  changes: z.array(changeSchema),
});

const expectationSchema = z.object({
  status: z.enum(["answered", "no_evidence"]),
  mode: z.enum(["version", "change"]).optional(),
  version: z.string().optional(),
  changeIds: z.array(z.string().min(1)).default([]),
  evidenceUrls: z.array(z.string().url()).default([]),
  contributors: z.array(z.string().min(1)).default([]),
});

const questionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "expected kebab-case question id"),
  question: z.string().min(3).max(500),
  expected: expectationSchema,
});

const corpusSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "expected kebab-case corpus id"),
    name: z.string().min(1).max(200),
    workspaceId: z.string().min(1),
    evaluatedAt: z.string().datetime({ offset: true }).optional(),
    history: z.object({
      versions: z.array(versionSchema).max(200),
      inDevelopment: z.array(changeSchema).max(200),
    }),
    questions: z.array(questionSchema).min(1).max(500),
    thresholds: z.object({
      passRate: z.number().min(0).max(1),
      citationPrecision: z.number().min(0).max(1),
      refusalAccuracy: z.number().min(0).max(1),
    }),
  })
  .superRefine((corpus, context) => {
    const questionIds = new Set<string>();
    corpus.questions.forEach((question, index) => {
      if (questionIds.has(question.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate question id: ${question.id}`,
          path: ["questions", index, "id"],
        });
      }
      questionIds.add(question.id);
    });
  });

export type AskGoldenCorpus = z.infer<typeof corpusSchema>;
export type AskGoldenQuestion = AskGoldenCorpus["questions"][number];

export const execute = (input: unknown): AskGoldenCorpus =>
  corpusSchema.parse(input);
