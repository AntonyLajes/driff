import { describe, expect, it, vi } from "vitest";

import { ensurePersonalTeam } from "@/teams/ensure-personal-team.js";

const userId = "00000000-0000-4000-8000-000000000099";

const selectReturning = (rows: unknown[]) => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
  })),
});

describe("teams/ensure-personal-team", () => {
  it("creates the personal team with a friendly slug and owner membership", async () => {
    const teamValues = vi.fn(async () => undefined);
    const memberOnConflict = vi.fn(async () => undefined);
    const insert = vi
      .fn()
      .mockImplementationOnce(() => ({ values: teamValues }))
      .mockImplementationOnce(() => ({
        values: vi.fn(() => ({ onConflictDoNothing: memberOnConflict })),
      }));
    const db = { select: vi.fn(() => selectReturning([])), insert } as never;

    await ensurePersonalTeam(db, {
      userId,
      name: "Antony Lajes",
      email: "antony@superhealth.xyz",
    });

    expect(teamValues).toHaveBeenCalledWith(
      expect.objectContaining({ id: userId, slug: "antony-lajes", isPersonal: true }),
    );
    expect(memberOnConflict).toHaveBeenCalledOnce();
  });

  it("upgrades a legacy personal slug in place", async () => {
    const setWhere = vi.fn(async () => undefined);
    const update = vi.fn(() => ({ set: vi.fn(() => ({ where: setWhere })) }));
    const insert = vi.fn().mockImplementationOnce(() => ({
      values: vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => undefined) })),
    }));
    const db = {
      select: vi.fn(() => selectReturning([{ slug: "personal-abc123" }])),
      update,
      insert,
    } as never;

    await ensurePersonalTeam(db, { userId, name: null, email: "diego@acme.io" });

    expect(update).toHaveBeenCalledOnce();
  });

  it("leaves an already-friendly slug untouched", async () => {
    const update = vi.fn();
    const insert = vi.fn().mockImplementationOnce(() => ({
      values: vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => undefined) })),
    }));
    const db = {
      select: vi.fn(() => selectReturning([{ slug: "antony" }])),
      update,
      insert,
    } as never;

    await ensurePersonalTeam(db, { userId, name: "Antony", email: "antony@x.io" });

    expect(update).not.toHaveBeenCalled();
  });
})
