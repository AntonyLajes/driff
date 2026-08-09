import { describe, expect, it } from "vitest";

import { parseArgs } from "@/cli/backfill-lineages.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";

describe("cli/backfill-lineages parseArgs", () => {
  it("should require a workspace and default to dry run", () => {
    expect(parseArgs(["--workspace-id", workspaceId])).toEqual({
      workspaceId,
      apply: false,
    });
  });

  it("should only mutate with an explicit apply flag", () => {
    expect(
      parseArgs([`--workspace-id=${workspaceId}`, "--apply"]),
    ).toEqual({ workspaceId, apply: true });
  });

  it("should reject invalid or unknown arguments", () => {
    expect(() => parseArgs(["--workspace-id", "invalid"])).toThrow();
    expect(() =>
      parseArgs(["--workspace-id", workspaceId, "--force"]),
    ).toThrow("Unknown option");
  });
});
