import { describe, expect, it, vi } from "vitest";

import { execute } from "@/history-imports/history-import-repository.js";

const IMPORT_ID = "00000000-0000-4000-8000-000000000111";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000222";
const USER_ID = "00000000-0000-4000-8000-000000000333";

const row = {
  id: IMPORT_ID,
  workspaceId: WORKSPACE_ID,
  requestedByUserId: USER_ID,
  status: "pending",
  periodMonths: 12,
  maxPullRequests: 100,
  totalItems: 0,
  processedItems: 0,
  failedItems: 0,
  completedPrNumbers: [],
  failures: [],
  truncated: false,
  cancelRequested: false,
  lastError: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date("2026-08-09T00:00:00.000Z"),
  updatedAt: new Date("2026-08-09T00:00:00.000Z"),
};

const buildDb = (terminalResults: unknown[]) => {
  const next = async () => terminalResults.shift();
  const returning = vi.fn(next);
  const limit = vi.fn(next);
  const whereResult = {
    limit,
    orderBy: vi.fn(() => ({ limit })),
    returning,
    then: (resolve: (value: unknown) => void) => resolve(undefined),
  };
  const where = vi.fn(() => whereResult);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return {
    db: { select, insert, update } as never,
    spies: { select, insert, update, values, set, where, limit, returning },
  };
};

describe("history-imports/history-import-repository", () => {
  it("should create and read history imports", async () => {
    const { db } = buildDb([[row], [row], [row]]);
    const repository = execute({ db });

    await expect(
      repository.create({
        workspaceId: WORKSPACE_ID,
        requestedByUserId: USER_ID,
        periodMonths: 12,
        maxPullRequests: 100,
      }),
    ).resolves.toMatchObject({ id: IMPORT_ID, status: "pending" });
    await expect(repository.findById(IMPORT_ID)).resolves.toMatchObject({
      id: IMPORT_ID,
    });
    await expect(
      repository.findLatestForWorkspace(WORKSPACE_ID),
    ).resolves.toMatchObject({
      id: IMPORT_ID,
    });
  });

  it("should return null for missing reads and reject missing inserts", async () => {
    const { db } = buildDb([[], [], []]);
    const repository = execute({ db });

    await expect(
      repository.create({
        workspaceId: WORKSPACE_ID,
        requestedByUserId: USER_ID,
        periodMonths: 12,
        maxPullRequests: 100,
      }),
    ).rejects.toThrow("insert returned no row");
    await expect(repository.findById(IMPORT_ID)).resolves.toBeNull();
    await expect(
      repository.findLatestForWorkspace(WORKSPACE_ID),
    ).resolves.toBeNull();
  });

  it("should persist lifecycle and progress updates", async () => {
    const { db, spies } = buildDb([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const repository = execute({ db });
    const now = new Date("2026-08-09T12:00:00.000Z");

    await repository.markRunning(IMPORT_ID, now);
    await repository.markDiscovered({
      id: IMPORT_ID,
      totalItems: 2,
      truncated: true,
      updatedAt: now,
    });
    await repository.updateProgress({
      id: IMPORT_ID,
      completedPrNumbers: [1],
      failures: [{ prNumber: 2, message: "failed" }],
      updatedAt: now,
    });
    await repository.markTerminal({
      id: IMPORT_ID,
      status: "partial",
      completedAt: now,
    });
    await repository.markFailed({
      id: IMPORT_ID,
      message: "offline",
      updatedAt: now,
    });

    expect(spies.set).toHaveBeenCalledTimes(5);
    expect(spies.set).toHaveBeenCalledWith(
      expect.objectContaining({ processedItems: 2, failedItems: 1 }),
    );
    expect(spies.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "partial", completedAt: now }),
    );
  });

  it("should read cancellation and request it within the workspace", async () => {
    const { db } = buildDb([
      [{ cancelRequested: false }],
      [{ id: IMPORT_ID }],
      [],
      [],
    ]);
    const repository = execute({ db });

    await expect(repository.isCancellationRequested(IMPORT_ID)).resolves.toBe(
      false,
    );
    await expect(
      repository.requestCancellation(WORKSPACE_ID, IMPORT_ID, new Date()),
    ).resolves.toBe(true);
    await expect(
      repository.requestCancellation(WORKSPACE_ID, IMPORT_ID, new Date()),
    ).resolves.toBe(false);
    await expect(repository.isCancellationRequested(IMPORT_ID)).resolves.toBe(
      true,
    );
  });
});
