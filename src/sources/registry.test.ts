import { describe, expect, it } from "vitest";

import {
  getSource,
  isImplementedProvider,
  sourceProviderSchema,
  UnsupportedProviderError,
} from "@/sources/registry.js";

describe("sources/registry", () => {
  it("accepts known providers in the schema", () => {
    expect(sourceProviderSchema.safeParse("github").success).toBe(true);
    expect(sourceProviderSchema.safeParse("gitlab").success).toBe(true);
    expect(sourceProviderSchema.safeParse("bitbucket").success).toBe(true);
    expect(sourceProviderSchema.safeParse("svn").success).toBe(false);
  });

  it("marks only github as implemented today", () => {
    expect(isImplementedProvider("github")).toBe(true);
    expect(isImplementedProvider("gitlab")).toBe(false);
    expect(isImplementedProvider("bitbucket")).toBe(false);
  });

  it("returns a Source for github", () => {
    const source = getSource("github", {
      appId: "1",
      privateKey: "key",
      octokitFactory: () => ({}) as never,
    });
    expect(typeof source.fetchPullRequest).toBe("function");
  });

  it("throws UnsupportedProviderError for providers without an implementation", () => {
    expect(() => getSource("gitlab")).toThrow(UnsupportedProviderError);
    expect(() => getSource("bitbucket")).toThrow(/unsupported_provider/);
  });
});
