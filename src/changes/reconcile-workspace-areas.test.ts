import { describe, expect, it } from "vitest";

import {
  buildAreaReconciliationPlan,
  summarizeAreaReconciliationPlan,
} from "@/changes/reconcile-workspace-areas.js";

describe("changes/reconcile-workspace-areas", () => {
  it("plans stable aliases, hierarchy leaves and stale assignment removal", () => {
    const plan = buildAreaReconciliationPlan(
      [
        { changeId: "change-a", rawArea: "authentication" },
        { changeId: "change-b", rawArea: "Payments / Checkout" },
        { changeId: "change-c", rawArea: null },
        { changeId: "change-a", rawArea: "authentication" },
      ],
      [
        { changeId: "change-a", slug: "authentication" },
        { changeId: "change-b", slug: "checkout" },
        { changeId: "change-c", slug: "legacy" },
      ],
    );

    expect(plan).toEqual([
      expect.objectContaining({
        changeId: "change-a",
        currentSlugs: ["authentication"],
        target: { name: "Auth", slug: "auth" },
        changed: true,
      }),
      expect.objectContaining({
        changeId: "change-b",
        currentSlugs: ["checkout"],
        target: { name: "Checkout", slug: "checkout" },
        changed: false,
      }),
      expect.objectContaining({
        changeId: "change-c",
        currentSlugs: ["legacy"],
        target: null,
        changed: true,
      }),
    ]);
  });

  it("sorts and deduplicates multiple current assignments", () => {
    const [item] = buildAreaReconciliationPlan(
      [{ changeId: "change", rawArea: "theme" }],
      [
        { changeId: "change", slug: "theming" },
        { changeId: "change", slug: "theme" },
        { changeId: "change", slug: "theme" },
      ],
    );

    expect(item).toEqual(
      expect.objectContaining({
        currentSlugs: ["theme", "theming"],
        target: { name: "Theme", slug: "theme" },
        changed: true,
      }),
    );
  });

  it("detects a new assignment when a change has no current area", () => {
    const [item] = buildAreaReconciliationPlan(
      [{ changeId: "new-change", rawArea: "developer API" }],
      [],
    );

    expect(item).toEqual(
      expect.objectContaining({
        currentSlugs: [],
        target: { name: "Developer API", slug: "developer-api" },
        changed: true,
      }),
    );
  });

  it("summarizes dry-run and apply plans with stable target counts", () => {
    const plan = buildAreaReconciliationPlan(
      [
        { changeId: "a", rawArea: "authentication" },
        { changeId: "b", rawArea: "auth" },
        { changeId: "c", rawArea: null },
      ],
      [
        { changeId: "a", slug: "authentication" },
        { changeId: "b", slug: "auth" },
        { changeId: "c", slug: "legacy" },
      ],
    );

    expect(summarizeAreaReconciliationPlan(plan, false)).toEqual({
      mode: "dry_run",
      candidates: 3,
      changed: 2,
      unchanged: 1,
      removed: 1,
      targets: { auth: 2 },
    });
    expect(summarizeAreaReconciliationPlan(plan, true).mode).toBe("apply");
  });
});
