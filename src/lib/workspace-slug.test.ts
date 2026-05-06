import { describe, expect, it } from "vitest";

import { normalizeWorkspaceSlug, slugifyWorkspaceName } from "@/lib/workspace-slug.js";

describe("lib/workspace-slug", () => {
  it("slugifies display names", () => {
    expect(slugifyWorkspaceName("My Cool App")).toBe("my-cool-app");
    expect(slugifyWorkspaceName("  RN  ")).toBe("rn");
  });

  it("uses fallback when name normalizes to empty", () => {
    expect(slugifyWorkspaceName("!!!")).toBe("workspace");
  });

  it("normalizes explicit slugs", () => {
    expect(normalizeWorkspaceSlug("  My_Slug  ")).toBe("my-slug");
    expect(normalizeWorkspaceSlug("a--b")).toBe("a-b");
  });
});
