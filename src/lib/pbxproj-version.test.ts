import { describe, expect, it } from "vitest";

import { execute } from "@/lib/pbxproj-version.js";

describe("lib/pbxproj-version execute", () => {
  it("should read last literal MARKETING_VERSION and CURRENT_PROJECT_VERSION", () => {
    const raw = `
MARKETING_VERSION = 1.0.0;
CURRENT_PROJECT_VERSION = 5;
OTHER = x;
MARKETING_VERSION = 2.0.0;
CURRENT_PROJECT_VERSION = 6;
`;
    expect(execute(raw)).toEqual({ short: "2.0.0", build: "6" });
  });

  it("should skip Xcode substitution values", () => {
    const raw = `
MARKETING_VERSION = "$(inherited)";
CURRENT_PROJECT_VERSION = "$(inherited)";
MARKETING_VERSION = 3.1.0;
CURRENT_PROJECT_VERSION = 40;
`;
    expect(execute(raw)).toEqual({ short: "3.1.0", build: "40" });
  });

  it("should return null when no literal versions", () => {
    expect(
      execute(`MARKETING_VERSION = "$(MARKETING_VERSION)"; CURRENT_PROJECT_VERSION = "$(CURRENT_PROJECT_VERSION)";`),
    ).toBeNull();
  });
});
