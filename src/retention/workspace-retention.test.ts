import { describe, expect, it, vi } from "vitest";

import {
  applyWorkspaceRetention,
  createWorkspaceRetentionJob,
  loadWorkspaceRetentionPreview,
  scheduleWorkspaceRetention,
} from "@/retention/workspace-retention.js";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";

describe("workspace retention", () => {
  it("returns a zero preview without touching storage when retention is disabled", async () => {
    const select = vi.fn();

    await expect(
      loadWorkspaceRetentionPreview({
        db: { select } as never,
        workspaceId: WORKSPACE_ID,
        repoFullName: "acme/app",
        retentionDays: null,
      }),
    ).resolves.toEqual({
      retentionDays: null,
      cutoff: null,
      rawWebhookEvents: 0,
      finishedJobs: 0,
      totalRecords: 0,
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("counts raw records older than the selected cutoff", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({ where: vi.fn(async () => [{ value: 4 }]) })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({ where: vi.fn(async () => [{ value: 7 }]) })),
      }));
    const now = new Date("2026-08-09T12:00:00.000Z");

    await expect(
      loadWorkspaceRetentionPreview({
        db: { select } as never,
        workspaceId: WORKSPACE_ID,
        repoFullName: "acme/app",
        retentionDays: 90,
        now,
      }),
    ).resolves.toEqual({
      retentionDays: 90,
      cutoff: new Date("2026-05-11T12:00:00.000Z"),
      rawWebhookEvents: 4,
      finishedJobs: 7,
      totalRecords: 11,
    });
  });

  it("disables future sweeps without inserting another job", async () => {
    const where = vi.fn(async () => undefined);
    const deleteFn = vi.fn(() => ({ where }));
    const insert = vi.fn();

    await scheduleWorkspaceRetention({
      db: { delete: deleteFn, insert } as never,
      workspaceId: WORKSPACE_ID,
      retentionDays: null,
    });

    expect(deleteFn).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
  });

  it("deletes eligible raw records and schedules the next daily sweep", async () => {
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [
              { repoFullName: "acme/app", retentionDays: 30 },
            ]),
          })),
        })),
      })),
    }));
    const transactionDelete = vi
      .fn()
      .mockImplementationOnce(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: "w1" }, { id: "w2" }]),
        })),
      }))
      .mockImplementationOnce(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: "j1" }]),
        })),
      }));
    const updateWhere = vi.fn(async () => undefined);
    const transaction = vi.fn(async (callback) =>
      callback({
        delete: transactionDelete,
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) })),
      }),
    );
    const scheduledDelete = vi.fn(() => ({
      where: vi.fn(async () => undefined),
    }));
    const scheduledValues = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values: scheduledValues }));
    const now = new Date("2026-08-09T12:00:00.000Z");

    await expect(
      applyWorkspaceRetention({
        db: { select, transaction, delete: scheduledDelete, insert } as never,
        workspaceId: WORKSPACE_ID,
        now,
      }),
    ).resolves.toMatchObject({
      retentionDays: 30,
      rawWebhookEvents: 2,
      finishedJobs: 1,
      totalRecords: 3,
    });
    expect(updateWhere).toHaveBeenCalledOnce();
    expect(scheduledValues).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply_retention",
        payload: { workspaceId: WORKSPACE_ID },
        status: "pending",
        availableAt: new Date("2026-08-10T12:00:00.000Z"),
      }),
    );
  });

  it("rejects malformed retention jobs", async () => {
    const job = createWorkspaceRetentionJob({ db: {} as never });
    await expect(job.execute({ workspaceId: "bad" })).rejects.toThrow(
      "Invalid apply_retention payload.",
    );
  });
});
