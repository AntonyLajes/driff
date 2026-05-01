import { describe, expect, it } from "vitest";

import {
  execute,
  isCommitMessagePrReferenced,
} from "@/lib/release-commit-hints.js";

describe("lib/release-commit-hints isCommitMessagePrReferenced", () => {
  it("should be true for merge PR line", () => {
    expect(isCommitMessagePrReferenced("Merge pull request #88 from org/feat")).toBe(true);
  });

  it("should be true for squash suffix", () => {
    expect(isCommitMessagePrReferenced("feat: xyz (#41)")).toBe(true);
  });

  it("should be false for direct commit", () => {
    expect(isCommitMessagePrReferenced("fix: typo in copy")).toBe(false);
  });
});

describe("lib/release-commit-hints execute", () => {
  it("should keep only commits without PR markers", () => {
    const hints = execute([
      { sha: "a", message: "Merge pull request #1 from x/y" },
      { sha: "b", message: "chore(ci): plist\n\nbody" },
      { sha: "c", message: "land thing (#99)" },
    ]);
    expect(hints).toEqual([{ sha: "b", messageLine: "chore(ci): plist" }]);
  });

  it("should truncate long first lines", () => {
    const long = `${"x".repeat(300)}`;
    expect(execute([{ sha: "z", message: long }])[0]?.messageLine.length).toBeLessThanOrEqual(241);
  });
});
