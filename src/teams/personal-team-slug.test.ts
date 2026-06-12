import { describe, expect, it } from "vitest";

import { isLegacyPersonalSlug, personalTeamBaseSlug } from "@/teams/personal-team-slug.js";

describe("teams/personal-team-slug", () => {
  it("derives a slug from the display name", () => {
    expect(personalTeamBaseSlug("Antony Lajes", "antony@superhealth.xyz")).toBe(
      "antony-lajes",
    );
  });

  it("falls back to the email local part when no name", () => {
    expect(personalTeamBaseSlug(null, "antony@superhealth.xyz")).toBe("antony");
    expect(personalTeamBaseSlug("", "diego.alves@acme.io")).toBe("diego-alves");
  });

  it("falls back to 'user' when nothing usable", () => {
    expect(personalTeamBaseSlug(null, null)).toBe("user");
    expect(personalTeamBaseSlug("", "@nodomain")).toBe("user");
  });

  it("flags legacy personal slugs", () => {
    expect(isLegacyPersonalSlug("personal-abc123")).toBe(true);
    expect(isLegacyPersonalSlug("antony")).toBe(false);
  });
});
