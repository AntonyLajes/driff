import { describe, expect, it } from "vitest";

import {
  buildSuggestedLineageKey,
  fingerprintChange,
  scoreFingerprintMatch,
  shouldAutoLink,
  suggestRelation,
} from "@/lineages/match-candidate.js";

describe("lineages/match-candidate", () => {
  const introduction = fingerprintChange({
    title: "Add quick action buttons to Home",
    category: "feature",
    areaSlugs: ["home"],
    filePaths: ["src/screens/HomeScreen.tsx"],
  });
  const improvement = fingerprintChange({
    title: "Improve touch feedback on Home quick action buttons",
    category: "feature",
    areaSlugs: ["home"],
    filePaths: ["src/screens/HomeScreen.tsx"],
  });
  const correction = fingerprintChange({
    title: "Fix quick action button accessibility",
    category: "bugfix",
    areaSlugs: ["home"],
    filePaths: ["src/screens/HomeScreen.tsx"],
  });

  it("should reconstruct three conservative matches for the same component", () => {
    const improvementScore = scoreFingerprintMatch(introduction, improvement);
    const correctionScore = scoreFingerprintMatch(improvement, correction);

    expect(improvementScore).toBeGreaterThanOrEqual(75);
    expect(correctionScore).toBeGreaterThanOrEqual(75);
    expect(shouldAutoLink(improvementScore)).toBe(true);
    expect(shouldAutoLink(correctionScore)).toBe(true);
    expect(
      suggestRelation(
        { title: "Add quick action buttons", category: "feature" },
        false,
      ),
    ).toBe("introduced");
    expect(
      suggestRelation(
        { title: "Improve quick action buttons", category: "feature" },
        true,
      ),
    ).toBe("modified");
    expect(
      suggestRelation(
        { title: "Fix quick action button accessibility", category: "bugfix" },
        true,
      ),
    ).toBe("fixed");
  });

  it("should not join unrelated features that only share a broad area", () => {
    const banner = fingerprintChange({
      title: "Add promotional banner carousel",
      category: "feature",
      areaSlugs: ["home"],
      filePaths: ["src/components/PromoCarousel.tsx"],
    });

    const score = scoreFingerprintMatch(introduction, banner);

    expect(score).toBeLessThan(75);
    expect(shouldAutoLink(score)).toBe(false);
  });

  it("should require a shared area even when terms and files overlap", () => {
    const settingsQuickActions = fingerprintChange({
      title: "Improve quick action buttons",
      category: "feature",
      areaSlugs: ["settings"],
      filePaths: ["src/screens/HomeScreen.tsx"],
    });

    expect(scoreFingerprintMatch(introduction, settingsQuickActions)).toBe(0);
  });

  it("should classify removals, restorations and stable initial keys", () => {
    expect(
      suggestRelation(
        { title: "Remove quick action buttons", category: "feature" },
        true,
      ),
    ).toBe("removed");
    expect(
      suggestRelation(
        { title: "Restore quick action buttons", category: "feature" },
        true,
      ),
    ).toBe("restored");
    expect(buildSuggestedLineageKey(introduction)).toBe(
      "home-action-button-home-quick",
    );
  });
});
