import { describe, expect, it, vi } from "vitest";

import { execute } from "@/changes/project-push.js";
import type { Database } from "@/db/client.js";
import {
  changeAreasTable,
  changeContributorsTable,
  changeEvidenceTable,
  changesTable,
  productAreasTable,
} from "@/db/schema.js";
import type { PushSummaryResult } from "@/llm/push-summarizer.js";
import type { PushContext } from "@/sources/github/gather-push-context.js";

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
  const lineageProjector = vi.fn(async () => ({
    kind: "projected" as const,
    lineageId: "lineage-id",
    lineageKey: "checkout",
    relationType: "fixed" as const,
    matchedExisting: true,
    matchScore: 100,
  }));

  return {
    db,
    insert,
    lineageProjector,
    onConflictDoUpdate,
    records,
    transaction,
  };
};

const context: PushContext = {
  compareCommits: [
    { sha: "b".repeat(40), message: "fix: prevent checkout crash" },
    { sha: "c".repeat(40), message: "test: cover empty cart" },
  ],
  commitMessages: ["fix: prevent checkout crash", "test: cover empty cart"],
  prNumbers: [],
  totalCommits: 2,
  compareUrl: `https://github.com/Acme/Mobile-App/compare/${"a".repeat(40)}...${"c".repeat(40)}`,
  fileChangeSummary: "modified: src/checkout.ts",
  additions: 18,
  deletions: 5,
  changedFiles: 2,
  diff: "diff --git a/src/checkout.ts b/src/checkout.ts",
};

const summary: PushSummaryResult = {
  title: "Checkout mais estável",
  summaryUserFacing: "Evita uma falha ao finalizar o carrinho.",
  summaryTechnical: "Protege o estado vazio antes de enviar o pedido.",
  category: "bugfix",
  area: "Pagamentos / Checkout",
};

const projectionInput = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sourceRecordId: "22222222-2222-4222-8222-222222222222",
  repo: "Acme/Mobile-App",
  branch: "main",
  beforeSha: "a".repeat(40),
  afterSha: "c".repeat(40),
  pusher: "Octo Cat",
  pushedAt: new Date("2026-08-08T12:00:00.000Z"),
  context,
  summary,
  promptVersion: 4,
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

describe("changes/project-push execute", () => {
  it("should project a direct push into one atomic canonical graph transaction", async () => {
    const {
      db,
      lineageProjector,
      onConflictDoUpdate,
      records,
      transaction,
    } = buildDbMock();

    await execute({ db, lineageProjector }).project(projectionInput);

    expect(transaction).toHaveBeenCalledOnce();
    expect(records).toHaveLength(5);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(5);

    expect(recordFor(records, changesTable).values).toEqual(
      expect.objectContaining({
        workspaceId: projectionInput.workspaceId,
        title: summary.title,
        summaryExecutive: summary.summaryUserFacing,
        summaryTechnical: summary.summaryTechnical,
        category: "bugfix",
        firstOccurredAt: projectionInput.pushedAt,
        lastOccurredAt: projectionInput.pushedAt,
        promptVersion: 4,
      }),
    );
    expect(recordFor(records, changesTable).values).not.toHaveProperty(
      "versionId",
    );

    expect(recordFor(records, changeEvidenceTable).values).toEqual([
      expect.objectContaining({
        kind: "compare",
        sourceKey: `github:acme/mobile-app:compare:${projectionInput.beforeSha}...${projectionInput.afterSha}`,
        externalId: projectionInput.afterSha,
        sourceRecordType: "pushes",
        sourceRecordId: projectionInput.sourceRecordId,
        metadata: {
          branch: "main",
          beforeSha: projectionInput.beforeSha,
          commitCount: 2,
          additions: 18,
          deletions: 5,
          changedFiles: 2,
        },
      }),
      expect.objectContaining({
        kind: "commit",
        sourceKey: `github:acme/mobile-app:commit:${"b".repeat(40)}`,
        externalId: "b".repeat(40),
        metadata: { branch: "main", message: "fix: prevent checkout crash" },
      }),
      expect.objectContaining({
        kind: "commit",
        sourceKey: `github:acme/mobile-app:commit:${"c".repeat(40)}`,
        externalId: "c".repeat(40),
      }),
      expect.objectContaining({
        kind: "file",
        path: "src/checkout.ts",
        sourceKey: `github:acme/mobile-app:compare:${projectionInput.beforeSha}...${projectionInput.afterSha}:file:src/checkout.ts`,
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
    expect(recordFor(records, changeContributorsTable).values).toEqual(
      expect.objectContaining({
        externalIdentity: "github:octo cat",
        displayName: "Octo Cat",
        role: "pusher",
        sourceUrl: "https://github.com/Octo%20Cat",
      }),
    );
    expect(lineageProjector).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: projectionInput.workspaceId,
        title: summary.title,
        category: "bugfix",
        areaSlug: "checkout",
        filePaths: ["src/checkout.ts"],
      }),
    );
  });

  it("should derive the same change id when the same push is projected again", async () => {
    const first = buildDbMock();
    const second = buildDbMock();

    await execute({
      db: first.db,
      lineageProjector: first.lineageProjector,
    }).project(projectionInput);
    await execute({
      db: second.db,
      lineageProjector: second.lineageProjector,
    }).project(projectionInput);

    expect(idFrom(recordFor(first.records, changesTable))).toBe(
      idFrom(recordFor(second.records, changesTable)),
    );
  });

  it("should omit area and contributor records when neither is known", async () => {
    const { db, insert, lineageProjector, records } = buildDbMock();

    await execute({ db, lineageProjector }).project({
      ...projectionInput,
      pusher: null,
      summary: { ...summary, area: null },
    });

    expect(records).toHaveLength(2);
    expect(insert).not.toHaveBeenCalledWith(productAreasTable);
    expect(insert).not.toHaveBeenCalledWith(changeAreasTable);
    expect(insert).not.toHaveBeenCalledWith(changeContributorsTable);
    expect(lineageProjector).not.toHaveBeenCalled();
  });

  it("should preserve a missing legacy prompt version", async () => {
    const { db, lineageProjector, records } = buildDbMock();

    await execute({ db, lineageProjector }).project({
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

    await expect(
      execute({ db, lineageProjector: vi.fn() }).project(projectionInput),
    ).rejects.toBe(cause);
  });
});
