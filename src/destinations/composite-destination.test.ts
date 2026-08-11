import { describe, expect, it, vi } from "vitest";

import { execute as createComposite } from "@/destinations/composite-destination.js";
import type {
  Destination,
  PRSummary,
  PushSummary,
  ReleaseNotesSummary,
} from "@/destinations/destination.js";

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

const releaseSummary: ReleaseNotesSummary = {
  title: "Version 1.0.0",
  repo: "acme/app",
  branch: "main",
  newVersionKey: "1.0.0+1",
  previousVersionKey: null,
  shortVersion: "1.0.0",
  buildVersion: "1",
  compareUrl: "https://example.com/compare",
  prNumbers: [1],
  changelog: "First release",
  sections: [],
};

const pushSummary: PushSummary = {
  repo: "acme/app",
  branch: "main",
  beforeSha: "a".repeat(40),
  afterSha: "b".repeat(40),
  pusher: "octocat",
  pushedAt: new Date("2026-01-02T00:00:00.000Z"),
  title: "Ship change",
  summaryUserFacing: "u",
  summaryTechnical: "t",
  category: "feature",
  area: "home",
  commitCount: 1,
  prNumbers: [1],
  compareUrl: "https://example.com/compare",
};

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

  it("fans release and push summaries through their matching publishers", async () => {
    const destination = stub("page-a");
    const composite = createComposite({ children: [{ label: "notion", destination }] });

    await expect(composite.publishRelease(releaseSummary)).resolves.toEqual({ pageId: "page-a" });
    await expect(composite.publishPush(pushSummary)).resolves.toEqual({ pageId: "page-a" });
    expect(destination.publishRelease).toHaveBeenCalledWith(releaseSummary);
    expect(destination.publishPush).toHaveBeenCalledWith(pushSummary);
  });

  it("uses its safe default logger when a destination fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = stub("unused");
    vi.mocked(failing.publishPush).mockRejectedValueOnce(new Error("down"));
    const composite = createComposite({ children: [{ label: "notion", destination: failing }] });

    await expect(composite.publishPush(pushSummary)).rejects.toThrow("All destinations failed");
    expect(warn).toHaveBeenCalledWith(
      'destination "notion" failed to publishPush:',
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
