import { describe, expect, it, vi } from "vitest";

import {
  canManageAdmins,
  canManageBilling,
  canManageMembers,
  canManageTeam,
  canWriteWorkspaces,
  readTeamIdHeader,
  resolveTeamContext,
} from "@/teams/team-context.js";

const USER_ID = "00000000-0000-4000-8000-000000000099";
const TEAM_ID = "00000000-0000-4000-8000-0000000000ee";

describe("teams/team-context", () => {
  it("reads the x-team-id header when present and non-empty", () => {
    expect(readTeamIdHeader({ "x-team-id": ` ${TEAM_ID} ` })).toBe(TEAM_ID);
    expect(readTeamIdHeader({})).toBeUndefined();
    expect(readTeamIdHeader({ "x-team-id": "  " })).toBeUndefined();
    expect(readTeamIdHeader({ "x-team-id": 42 })).toBeUndefined();
  });

  it("defaults to the personal team with zero queries when no team is requested", async () => {
    const select = vi.fn();
    const db = { select } as never;

    const result = await resolveTeamContext(db, USER_ID, undefined);

    expect(result).toEqual({
      kind: "ok",
      context: { teamId: USER_ID, role: "owner", isPersonal: true },
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("short-circuits when the requested team IS the personal team", async () => {
    const select = vi.fn();
    const db = { select } as never;

    const result = await resolveTeamContext(db, USER_ID, USER_ID);

    expect(result).toEqual({
      kind: "ok",
      context: { teamId: USER_ID, role: "owner", isPersonal: true },
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("returns invalid_team for a malformed team id", async () => {
    const select = vi.fn();
    const db = { select } as never;

    expect(await resolveTeamContext(db, USER_ID, "nope")).toEqual({
      kind: "invalid_team",
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("resolves role and personal flag from the membership row", async () => {
    const limit = vi.fn(async () => [{ role: "admin", isPersonal: false }]);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as never;

    const result = await resolveTeamContext(db, USER_ID, TEAM_ID);

    expect(result).toEqual({
      kind: "ok",
      context: { teamId: TEAM_ID, role: "admin", isPersonal: false },
    });
    expect(select).toHaveBeenCalledOnce();
  });

  it("encodes the role permission matrix", () => {
    expect([canWriteWorkspaces("owner"), canWriteWorkspaces("admin")]).toEqual([true, true]);
    expect(canWriteWorkspaces("member")).toBe(false);
    expect([canManageMembers("owner"), canManageMembers("admin")]).toEqual([true, true]);
    expect(canManageMembers("member")).toBe(false);
    expect([canManageAdmins("owner"), canManageAdmins("admin")]).toEqual([true, false]);
    expect([canManageBilling("owner"), canManageBilling("admin")]).toEqual([true, false]);
    expect([canManageTeam("owner"), canManageTeam("member")]).toEqual([true, false]);
  });

  it("returns not_a_member when no membership row exists", async () => {
    const limit = vi.fn(async () => []);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as never;

    expect(await resolveTeamContext(db, USER_ID, TEAM_ID)).toEqual({
      kind: "not_a_member",
    });
  });
});
