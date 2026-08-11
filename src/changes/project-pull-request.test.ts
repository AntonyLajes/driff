import { describe, expect, it, vi } from "vitest";

import { execute } from "@/changes/project-pull-request.js";
import type { Database } from "@/db/client.js";
import {
  changeAreasTable,
  changeContributorsTable,
  changeEvidenceTable,
  changesTable,
  productAreasTable,
} from "@/db/schema.js";
import type { PRSummary } from "@/llm/summarizer.js";
import type { PullRequestEvent } from "@/sources/source.js";

interface InsertRecord {
  table: unknown;
  values: unknown;
}

const buildDbMock = () => {
  const records: InsertRecord[] = [];
  const onConflictDoUpdate = vi.fn(async () => undefined);
  const insert = vi.fn((table: unknown) => ({
    values: (values: unknown) => {
      records.push({ table, values });
      return { onConflictDoUpdate };
    },
  }));
  const transaction = vi.fn(
    async (callback: (tx: { insert: typeof insert }) => Promise<void>) =>
      callback({ insert }),
  );
  const db = { transaction } as unknown as Database;

  return { db, insert, onConflictDoUpdate, records, transaction };
};

const pullRequest: PullRequestEvent = {
  repo: "Acme/Mobile-App",
  prNumber: 42,
  title: "feat: simplify checkout",
  body: "Ships a shorter checkout.",
  author: "Octo Cat",
  mergedAt: new Date("2026-08-08T12:00:00.000Z"),
  headSha: "abc123",
  baseBranch: "main",
  diff: "diff",
  files: [
    { path: "src/checkout/button.tsx", additions: 12, deletions: 2 },
    { path: "src/checkout/state.ts", additions: 8, deletions: 4 },
  ],
  participants: [
    {
      externalIdentity: "github:reviewer",
      displayName: "reviewer",
      role: "reviewer",
      sourceUrl: "https://github.com/reviewer",
      isBot: false,
    },
    {
      externalIdentity: "github:release-bot[bot]",
      displayName: "release-bot[bot]",
      role: "merger",
      sourceUrl: "https://github.com/release-bot%5Bbot%5D",
      isBot: true,
    },
  ],
};

const summary: PRSummary = {
  title: "Checkout mais rápido",
  summaryUserFacing: "Reduz os passos necessários para concluir uma compra.",
  summaryTechnical: "Simplifica o estado e o botão de checkout.",
  category: "feature",
  area: "Pagamentos / Checkout",
};

const projectionInput = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sourceRecordId: "22222222-2222-4222-8222-222222222222",
  pullRequest,
  summary,
  promptVersion: 3,
};

const recordFor = (records: InsertRecord[], table: unknown): InsertRecord => {
  const record = records.find((candidate) => candidate.table === table);
  if (record === undefined) {
    throw new Error("Expected insert record was not found.");
  }
  return record;
};

const idFrom = (record: InsertRecord): string => {
  if (
    typeof record.values !== "object" ||
    record.values === null ||
    !("id" in record.values) ||
    typeof record.values.id !== "string"
  ) {
    throw new Error("Expected insert record to contain a string id.");
  }
  return record.values.id;
};

const createProjector = (db: Database) =>
  execute({
    db,
    lineageProjector: vi.fn(async () => ({
      kind: "unassigned" as const,
      reason: "insufficient_identity" as const,
    })),
  });

describe("changes/project-pull-request execute", () => {
  it("should project a PR into one atomic canonical graph transaction", async () => {
    const { db, onConflictDoUpdate, records, transaction } = buildDbMock();

    const lineageProjector = vi.fn(async () => ({
      kind: "unassigned" as const,
      reason: "insufficient_identity" as const,
    }));
    await execute({ db, lineageProjector }).project(projectionInput);

    expect(transaction).toHaveBeenCalledOnce();
    expect(records).toHaveLength(6);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(6);

    const change = recordFor(records, changesTable).values;
    expect(change).toEqual(
      expect.objectContaining({
        workspaceId: projectionInput.workspaceId,
        title: summary.title,
        summaryExecutive: summary.summaryUserFacing,
        summaryTechnical: summary.summaryTechnical,
        category: "feature",
        firstOccurredAt: pullRequest.mergedAt,
        lastOccurredAt: pullRequest.mergedAt,
        promptVersion: 3,
      }),
    );
    expect(change).not.toHaveProperty("versionId");

    const evidence = recordFor(records, changeEvidenceTable).values;
    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "pull_request",
        sourceKey: "github:acme/mobile-app:pull_request:42",
        externalId: "42",
        sourceRecordType: "pull_requests",
        sourceRecordId: projectionInput.sourceRecordId,
      }),
      expect.objectContaining({
        kind: "file",
        sourceKey:
          "github:acme/mobile-app:pull_request:42:file:src/checkout/button.tsx",
        path: "src/checkout/button.tsx",
        metadata: { additions: 12, deletions: 2 },
      }),
      expect.objectContaining({
        kind: "file",
        sourceKey:
          "github:acme/mobile-app:pull_request:42:file:src/checkout/state.ts",
        path: "src/checkout/state.ts",
        metadata: { additions: 8, deletions: 4 },
      }),
    ]);

    expect(recordFor(records, productAreasTable).values).toEqual(
      expect.objectContaining({
        workspaceId: projectionInput.workspaceId,
        name: "Checkout",
        slug: "checkout",
      }),
    );
    expect(recordFor(records, changeAreasTable).values).toEqual(
      expect.objectContaining({ source: "ai" }),
    );
    const contributorRecords = records.filter(
      (record) => record.table === changeContributorsTable,
    );
    expect(contributorRecords[0]?.values).toEqual(
      expect.objectContaining({
        externalIdentity: "github:octo cat",
        displayName: "Octo Cat",
        role: "pr_author",
        sourceUrl: "https://github.com/Octo%20Cat",
        isBot: false,
      }),
    );
    expect(contributorRecords[1]?.values).toEqual([
      expect.objectContaining({
        externalIdentity: "github:reviewer",
        role: "reviewer",
        isBot: false,
      }),
      expect.objectContaining({
        externalIdentity: "github:release-bot[bot]",
        role: "merger",
        isBot: true,
      }),
    ]);
    expect(lineageProjector).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        workspaceId: projectionInput.workspaceId,
        changeId: idFrom(recordFor(records, changesTable)),
        title: summary.title,
        category: summary.category,
        areaId: idFrom(recordFor(records, productAreasTable)),
        areaSlug: "checkout",
        filePaths: pullRequest.files.map((file) => file.path),
      }),
    );
  });

  it("should derive the same entity ids when the same PR is projected again", async () => {
    const first = buildDbMock();
    const second = buildDbMock();

    await createProjector(first.db).project(projectionInput);
    await createProjector(second.db).project(projectionInput);

    expect(idFrom(recordFor(first.records, changesTable))).toBe(
      idFrom(recordFor(second.records, changesTable)),
    );
    expect(idFrom(recordFor(first.records, productAreasTable))).toBe(
      idFrom(recordFor(second.records, productAreasTable)),
    );
  });

  it("should omit area records when the summary has no product area", async () => {
    const { db, insert, records } = buildDbMock();

    await createProjector(db).project({
      ...projectionInput,
      summary: { ...summary, area: null },
    });

    expect(records).toHaveLength(4);
    expect(insert).not.toHaveBeenCalledWith(productAreasTable);
    expect(insert).not.toHaveBeenCalledWith(changeAreasTable);
  });

  it("should preserve a missing legacy prompt version", async () => {
    const { db, records } = buildDbMock();

    await createProjector(db).project({
      ...projectionInput,
      promptVersion: null,
    });

    expect(recordFor(records, changesTable).values).toEqual(
      expect.objectContaining({ promptVersion: null }),
    );
  });

  it("should propagate transaction failures without partial success", async () => {
    const cause = new Error("database unavailable");
    const db = {
      transaction: vi.fn(async () => Promise.reject(cause)),
    } as unknown as Database;

    await expect(createProjector(db).project(projectionInput)).rejects.toBe(
      cause,
    );
  });
});
