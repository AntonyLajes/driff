import { describe, expect, it } from "vitest";

import { normalizeProductArea } from "@/changes/normalize-product-area.js";

describe("changes/normalize-product-area", () => {
  it.each([
    ["authentication", { name: "Auth", slug: "auth" }],
    ["Auth", { name: "Auth", slug: "auth" }],
    ["theming", { name: "Theme", slug: "theme" }],
    ["i18n", { name: "Localization", slug: "localization" }],
    ["create-ride wizard", { name: "Ride creation", slug: "ride-creation" }],
    ["Ride creation", { name: "Ride creation", slug: "ride-creation" }],
    ["ride screens", { name: "Rides", slug: "rides" }],
  ])("normalizes the alias %s", (raw, expected) => {
    expect(normalizeProductArea(raw)).toEqual(expected);
  });

  it.each([
    ["Payments / Checkout", { name: "Checkout", slug: "checkout" }],
    ["auth/onboarding", { name: "Onboarding", slug: "onboarding" }],
    ["android > splash screen", { name: "Splash screen", slug: "splash-screen" }],
    ["settings :: theme", { name: "Theme", slug: "theme" }],
  ])("keeps the most specific segment from %s", (raw, expected) => {
    expect(normalizeProductArea(raw)).toEqual(expected);
  });

  it("creates a readable stable name for an unknown area", () => {
    expect(normalizeProductArea("developer API")).toEqual({
      name: "Developer API",
      slug: "developer-api",
    });
  });

  it.each([null, undefined, "", "  ", "///"])(
    "omits an empty area (%s)",
    (raw) => {
      expect(normalizeProductArea(raw)).toBeNull();
    },
  );
});
