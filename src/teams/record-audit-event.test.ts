import { describe, expect, it, vi } from "vitest";

import { teamAuditEventsTable } from "@/db/schema.js";
import { execute } from "@/teams/record-audit-event.js";

describe("teams/record-audit-event", () => {
  it("persists only the administrative event fields", async () => {
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    const record = execute({ db: { insert } as never });

    await record({
      teamId: "00000000-0000-4000-8000-0000000000aa",
      actorUserId: "00000000-0000-4000-8000-0000000000bb",
      action: "team_renamed",
      targetType: "team",
      targetId: "00000000-0000-4000-8000-0000000000aa",
      targetLabel: "Driff",
      metadata: { name: "Driff" },
    });

    expect(insert).toHaveBeenCalledWith(teamAuditEventsTable);
    expect(values).toHaveBeenCalledWith({
      teamId: "00000000-0000-4000-8000-0000000000aa",
      actorUserId: "00000000-0000-4000-8000-0000000000bb",
      action: "team_renamed",
      targetType: "team",
      targetId: "00000000-0000-4000-8000-0000000000aa",
      targetLabel: "Driff",
      metadata: { name: "Driff" },
    });
  });
});
