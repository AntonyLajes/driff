import { describe, expect, it, vi } from "vitest";

import { execute } from "@/analytics/load-system-readiness.js";

const flatSelect = (rows: unknown[]) => () => ({
  from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
});

const groupedSelect = (rows: unknown[]) => () => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({ groupBy: vi.fn(async () => rows) })),
  })),
});

describe("analytics/load-system-readiness", () => {
  it("should report searchable history and usable destinations", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(flatSelect([{ id: "w1" }, { id: "w2" }]))
      .mockImplementationOnce(
        groupedSelect([
          { workspaceId: "w1", changes: 4 },
          { workspaceId: "w2", changes: 0 },
        ]),
      )
      .mockImplementationOnce(
        flatSelect([
          { workspaceId: "w1", enabled: true, secretCiphertext: "sealed" },
          { workspaceId: "w1", enabled: false, secretCiphertext: "sealed-2" },
          { workspaceId: "w2", enabled: true, secretCiphertext: null },
        ]),
      );

    await expect(
      execute({ db: { select } as never, teamId: "team-1" }),
    ).resolves.toEqual({
      projects: 2,
      searchableProjects: 1,
      searchableChanges: 4,
      connectedDestinations: 2,
      enabledDestinations: 1,
      deliveryProjects: 1,
    });
  });

  it("should avoid readiness scans when the team has no projects", async () => {
    const select = vi.fn().mockImplementationOnce(flatSelect([]));
    await expect(
      execute({ db: { select } as never, teamId: "team-1" }),
    ).resolves.toEqual({
      projects: 0,
      searchableProjects: 0,
      searchableChanges: 0,
      connectedDestinations: 0,
      enabledDestinations: 0,
      deliveryProjects: 0,
    });
    expect(select).toHaveBeenCalledOnce();
  });
});
