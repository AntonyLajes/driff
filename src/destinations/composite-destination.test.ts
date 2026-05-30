import { describe, expect, it, vi } from "vitest";

import { execute as createComposite } from "@/destinations/composite-destination.js";
import type { Destination, PRSummary } from "@/destinations/destination.js";

const prSummary: PRSummary = {
  repo: "acme/app",
  prNumber: 1,
  title: "Add thing",
  author: "octocat",
  mergedAt: new Date("2026-01-01T00:00:00.000Z"),
  summaryUserFacing: "u",
  summaryTechnical: "t",
  category: "feature",
  area: null,
  prUrl: "https://example.com/pr/1",
};

const stub = (pageId: string): Destination => ({
  publishPR: vi.fn(async () => ({ pageId })),
  publishRelease: vi.fn(async () => ({ pageId })),
  publishPush: vi.fn(async () => ({ pageId })),
});

describe("destinations/composite-destination", () => {
  it("publishes to every child and returns the first page id", async () => {
    const a = stub("page-a");
    const b = stub("page-b");
    const composite = createComposite({
      children: [
        { label: "notion", destination: a },
        { label: "slack", destination: b },
      ],
    });

    const result = await composite.publishPR(prSummary);

    expect(a.publishPR).toHaveBeenCalledOnce();
    expect(b.publishPR).toHaveBeenCalledOnce();
    expect(result.pageId).toBe("page-a");
  });

  it("isolates a failing child so the others still publish", async () => {
    const failing: Destination = {
      publishPR: vi.fn(async () => {
        throw new Error("notion down");
      }),
      publishRelease: vi.fn(),
      publishPush: vi.fn(),
    };
    const ok = stub("page-ok");
    const logError = vi.fn();
    const composite = createComposite({
      children: [
        { label: "notion", destination: failing },
        { label: "slack", destination: ok },
      ],
      logError,
    });

    const result = await composite.publishPR(prSummary);

    expect(ok.publishPR).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith("notion", "publishPR", expect.any(Error));
    expect(result.pageId).toBe("page-ok");
  });

  it("throws only when every child fails", async () => {
    const failing: Destination = {
      publishPR: vi.fn(async () => {
        throw new Error("down");
      }),
      publishRelease: vi.fn(),
      publishPush: vi.fn(),
    };
    const composite = createComposite({
      children: [{ label: "notion", destination: failing }],
      logError: vi.fn(),
    });

    await expect(composite.publishPR(prSummary)).rejects.toThrow(/All destinations failed/);
  });
});
