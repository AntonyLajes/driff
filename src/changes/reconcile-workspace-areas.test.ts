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
        { changeId: "change-a", name: "authentication", slug: "authentication" },
        { changeId: "change-b", name: "Checkout", slug: "checkout" },
        { changeId: "change-c", name: "legacy", slug: "legacy" },
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
        { changeId: "change", name: "theming", slug: "theming" },
        { changeId: "change", name: "Theme", slug: "theme" },
        { changeId: "change", name: "Theme", slug: "theme" },
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

  it("updates a display name even when the stable slug already matches", () => {
    const [item] = buildAreaReconciliationPlan(
      [{ changeId: "home-change", rawArea: "home" }],
      [{ changeId: "home-change", name: "home", slug: "home" }],
    );

    expect(item).toEqual(
      expect.objectContaining({
        currentSlugs: ["home"],
        target: { name: "Home", slug: "home" },
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
        { changeId: "a", name: "authentication", slug: "authentication" },
        { changeId: "b", name: "Auth", slug: "auth" },
        { changeId: "c", name: "legacy", slug: "legacy" },
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
