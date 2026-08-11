import { describe, expect, it } from "vitest";

import { parseArgs } from "@/cli/backfill-workspace.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";

describe("cli/backfill-workspace parseArgs", () => {
  it("should default to a non-mutating dry run", () => {
    expect(
      parseArgs(["--workspace-id", workspaceId, "--repo", "acme/app"]),
    ).toEqual({ workspaceId, repo: "acme/app", apply: false });
  });

  it("should require an explicit apply flag before mutations", () => {
    expect(
      parseArgs([
        `--workspace-id=${workspaceId}`,
        "--repo=acme/app",
        "--apply",
      ]),
    ).toEqual({ workspaceId, repo: "acme/app", apply: true });
  });

  it("should reject malformed workspace and repository targets", () => {
    expect(() =>
      parseArgs(["--workspace-id", "not-a-uuid", "--repo", "acme"]),
    ).toThrow();
  });

  it("should reject unknown arguments", () => {
    expect(() =>
      parseArgs([
        "--workspace-id",
        workspaceId,
        "--repo",
        "acme/app",
        "--force",
      ]),
    ).toThrow("Unknown option");
  });
});
