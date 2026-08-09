import { describe, expect, it, vi } from "vitest";

import {
  execute,
  LineageChangeNotFoundError,
} from "@/lineages/upsert-membership.js";

const buildDb = (changeRows: unknown[], lineageId = "lineage-id") => {
  const limit = vi.fn(async () => changeRows);
  const whereSelect = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => [{ id: lineageId }]);
  const lineageConflict = vi.fn(() => ({ returning }));
  const lineageValues = vi.fn(() => ({ onConflictDoUpdate: lineageConflict }));
  const entryConflict = vi.fn(async () => undefined);
  const entryValues = vi.fn(() => ({ onConflictDoUpdate: entryConflict }));
  const insert = vi
    .fn()
    .mockReturnValueOnce({ values: lineageValues })
    .mockReturnValueOnce({ values: entryValues });

  const whereUpdate = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where: whereUpdate }));
  const update = vi.fn(() => ({ set }));
  const tx = { select, insert, update };
  const transaction = vi.fn(async (callback: (value: typeof tx) => unknown) =>
    callback(tx),
  );

  return {
    db: { transaction } as never,
    transaction,
    lineageValues,
    entryValues,
    update,
    set,
  };
};

describe("lineages/upsert-membership", () => {
  it("should create a stable lineage and attach an introduced change", async () => {
    const occurredAt = new Date("2026-08-08T12:00:00.000Z");
    const db = buildDb([{ lastOccurredAt: occurredAt }]);
    const now = new Date("2026-08-09T12:00:00.000Z");

    const result = await execute({
      db: db.db,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      changeId: "22222222-2222-4222-8222-222222222222",
      lineage: {
        key: "Home / Quick Actions",
        title: "Home quick actions",
        source: "rule",
        confidence: 92,
      },
      relationType: "introduced",
      assignmentSource: "rule",
      assignmentConfidence: 88,
      now,
    });

    expect(result).toEqual({
      lineageId: "lineage-id",
      lineageKey: "home-quick-actions",
    });
    expect(db.lineageValues).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "home-quick-actions",
        title: "Home quick actions",
        status: "active",
        confidence: 92,
      }),
    );
    expect(db.entryValues).toHaveBeenCalledWith(
      expect.objectContaining({
        lineageId: "lineage-id",
        relationType: "introduced",
        occurredAt,
        source: "rule",
        confidence: 88,
        correctedAt: null,
      }),
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it("should record human corrections and close a removed lineage", async () => {
    const db = buildDb([
      { lastOccurredAt: new Date("2026-08-08T12:00:00.000Z") },
    ]);
    const now = new Date("2026-08-09T12:00:00.000Z");

    await execute({
      db: db.db,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      changeId: "22222222-2222-4222-8222-222222222222",
      lineage: {
        key: "home-quick-actions",
        title: "Home quick actions",
        source: "human",
      },
      relationType: "removed",
      assignmentSource: "human",
      now,
    });

    expect(db.entryValues).toHaveBeenCalledWith(
      expect.objectContaining({
        relationType: "removed",
        source: "human",
        correctedAt: now,
      }),
    );
    expect(db.set).toHaveBeenCalledWith({ status: "removed", updatedAt: now });
  });

  it("should reject changes outside the requested workspace", async () => {
    const db = buildDb([]);

    await expect(
      execute({
        db: db.db,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        changeId: "22222222-2222-4222-8222-222222222222",
        lineage: {
          key: "checkout",
          title: "Checkout",
          source: "human",
        },
        relationType: "introduced",
        assignmentSource: "human",
      }),
    ).rejects.toBeInstanceOf(LineageChangeNotFoundError);
  });

  it("should reject invalid confidence before opening a transaction", async () => {
    const db = buildDb([]);

    await expect(
      execute({
        db: db.db,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        changeId: "22222222-2222-4222-8222-222222222222",
        lineage: {
          key: "checkout",
          title: "Checkout",
          source: "ai",
          confidence: 101,
        },
        relationType: "modified",
        assignmentSource: "ai",
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
