import { describe, expect, it, vi } from "vitest";

import { hasVersionKeyChanged, execute, normalizeReleasePrNumbers } from "@/jobs/process-release.js";

describe("jobs/process-release", () => {
  it("normalizeReleasePrNumbers should sort and dedupe", () => {
    expect(normalizeReleasePrNumbers([10, 2, 10, 7])).toEqual([2, 7, 10]);
    expect(normalizeReleasePrNumbers([])).toEqual([]);
  });

  it("hasVersionKeyChanged should be false when keys match", () => {
    expect(
      hasVersionKeyChanged({ previousVersionKey: "1.0+1", newVersionKey: "1.0+1" }),
    ).toBe(false);
  });

  it("hasVersionKeyChanged should be true when previous is null or keys differ", () => {
    expect(hasVersionKeyChanged({ previousVersionKey: null, newVersionKey: "1.0+1" })).toBe(
      true,
    );
    expect(
      hasVersionKeyChanged({ previousVersionKey: "1.0+1", newVersionKey: "1.0+2" }),
    ).toBe(true);
  });

  it("should throw on invalid process_release payload", async () => {
    const handler = execute({
      db: {} as never,
      appId: "1",
      privateKey: "k",
      infoPlistPath: "App/Info.plist",
      projectPbxprojPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease: vi.fn(), prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease: vi.fn() },
    });
    await expect(handler.execute({ repo: "", beforeSha: "a", afterSha: "b", branch: "x" })).rejects.toThrow(
      /Invalid process_release payload/,
    );
  });

});
