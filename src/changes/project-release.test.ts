import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { execute } from "@/changes/project-release.js";
import type { Database } from "@/db/client.js";

const versionId = "33333333-3333-4333-8333-333333333333";
const previousVersionId = "22222222-2222-4222-8222-222222222222";

const projectionInput = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sourceReleaseId: "44444444-4444-4444-8444-444444444444",
  repo: "Acme/Mobile-App",
  versionKey: "2.4.0+17",
  previousVersionKey: "2.3.0+16",
  shortVersion: "2.4.0",
  buildVersion: "17",
  title: "Checkout mais rápido",
  changelog: "A versão reduz etapas do checkout.",
  sections: [{ label: "Novidades", items: ["Checkout simplificado"] }],
  promptVersion: 2,
  beforeSha: "a".repeat(40),
  headSha: "b".repeat(40),
  compareUrl: "https://github.com/acme/mobile-app/compare/a...b",
  prNumbers: [42, 43],
  releasedAt: new Date("2026-08-08T12:00:00.000Z"),
};

const buildDbMock = (input?: {
  previousRows?: Array<{ id: string }>;
  versionRows?: Array<{ id: string }>;
  linkedRows?: Array<{ id: string }>;
}) => {
  const previousRows = input?.previousRows ?? [{ id: previousVersionId }];
  const versionRows = input?.versionRows ?? [{ id: versionId }];
  const linkedRows = input?.linkedRows ?? [{ id: "change-42" }, { id: "change-43" }];

  const previousLimit = vi.fn(async () => previousRows);
  const previousWhere = vi.fn(() => ({ limit: previousLimit }));
  const previousFrom = vi.fn(() => ({ where: previousWhere }));
  const evidenceSubquery = { getSQL: () => sql`select change_id from change_evidence` };
  const evidenceWhere = vi.fn(() => evidenceSubquery);
  const evidenceFrom = vi.fn(() => ({ where: evidenceWhere }));
  const select = vi
    .fn()
    .mockReturnValueOnce({ from: previousFrom })
    .mockReturnValueOnce({ from: evidenceFrom });

  const versionReturning = vi.fn(async () => versionRows);
  const onConflictDoUpdate = vi.fn(() => ({ returning: versionReturning }));
  const versionValues = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values: versionValues }));

  const updateReturning = vi.fn(async () => linkedRows);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const transaction = vi.fn(
    async (
      callback: (tx: {
        select: typeof select;
        insert: typeof insert;
        update: typeof update;
      }) => Promise<unknown>,
    ) => callback({ select, insert, update }),
  );
  const db = { transaction } as unknown as Database;

  return {
    db,
    evidenceWhere,
    insert,
    onConflictDoUpdate,
    previousLimit,
    select,
    transaction,
    update,
    updateReturning,
    updateSet,
    updateWhere,
    versionReturning,
    versionValues,
  };
};

describe("changes/project-release execute", () => {
  it("should project a release and link its unversioned PR changes atomically", async () => {
    const mocks = buildDbMock();

    const result = await execute({ db: mocks.db }).project(projectionInput);

    expect(result).toEqual({
      versionId,
      linkedChangeIds: ["change-42", "change-43"],
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.previousLimit).toHaveBeenCalledWith(1);
    expect(mocks.versionValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: projectionInput.workspaceId,
        displayVersion: "2.4.0",
        normalizedVersion: "2.4.0+17",
        buildVersion: "17",
        title: projectionInput.title,
        changelog: projectionInput.changelog,
        sections: projectionInput.sections,
        promptVersion: 2,
        status: "released",
        strategy: "version_file",
        sourceRef: "2.4.0+17",
        sourceReleaseId: projectionInput.sourceReleaseId,
        previousVersionId,
        releasedAt: projectionInput.releasedAt,
      }),
    );
    expect(mocks.evidenceWhere).toHaveBeenCalledOnce();
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ versionId }),
    );
    expect(mocks.updateReturning).toHaveBeenCalledOnce();
  });

  it("should project a first version without predecessor or PR updates", async () => {
    const mocks = buildDbMock();

    const result = await execute({ db: mocks.db }).project({
      ...projectionInput,
      previousVersionKey: null,
      prNumbers: [],
    });

    expect(result).toEqual({ versionId, linkedChangeIds: [] });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.versionValues).toHaveBeenCalledWith(
      expect.objectContaining({ previousVersionId: null }),
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("should fail without linking changes when the version upsert returns no id", async () => {
    const mocks = buildDbMock({ versionRows: [] });

    await expect(execute({ db: mocks.db }).project(projectionInput)).rejects.toThrow(
      "Project version upsert did not return an id.",
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
