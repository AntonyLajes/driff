import { describe, expect, it } from "vitest";

import {
  applyReleaseKindAndFilePath,
  collectVersionWatchPaths,
  inferKindAndPathFromLegacyPaths,
  isSupportedReleaseProjectKind,
  parseReleaseProjectKind,
} from "@/config/release-project-kind.js";

describe("config/release-project-kind", () => {
  it("should parse normalized kind strings", () => {
    expect(parseReleaseProjectKind("  IOS_PLIST ")).toBe("ios_plist");
    expect(parseReleaseProjectKind("react_native_expo")).toBe("react_native_expo");
    expect(parseReleaseProjectKind("node_package")).toBe("node_package");
  });

  it("should reject unknown kinds", () => {
    expect(() => parseReleaseProjectKind("windows")).toThrow();
  });

  it("should classify supported kinds", () => {
    expect(isSupportedReleaseProjectKind("ios_plist")).toBe(true);
    expect(isSupportedReleaseProjectKind("node_package")).toBe(true);
    expect(isSupportedReleaseProjectKind("android_gradle")).toBe(false);
  });

  it("should map ios_plist to legacy plist-only", () => {
    expect(applyReleaseKindAndFilePath("ios_plist", "App/Info.plist")).toEqual({
      releaseInfoPlistPath: "App/Info.plist",
      releaseProjectPbxprojPath: null,
      releaseExpoAppConfigPath: null,
    });
  });

  it("should map ios_pbx to pbx with empty plist sentinel", () => {
    expect(applyReleaseKindAndFilePath("ios_pbx", "x.xcodeproj/project.pbxproj")).toEqual({
      releaseInfoPlistPath: "",
      releaseProjectPbxprojPath: "x.xcodeproj/project.pbxproj",
      releaseExpoAppConfigPath: null,
    });
  });

  it("should map react_native_expo to expo path", () => {
    expect(applyReleaseKindAndFilePath("react_native_expo", "app.config.ts")).toEqual({
      releaseInfoPlistPath: "",
      releaseProjectPbxprojPath: null,
      releaseExpoAppConfigPath: "app.config.ts",
    });
  });

  it("should throw for unimplemented kinds", () => {
    expect(() => applyReleaseKindAndFilePath("android_gradle", "a.gradle")).toThrow(/not implemented/);
  });

  it("should keep package.json as a unified-only version source", () => {
    expect(applyReleaseKindAndFilePath("node_package", "package.json")).toEqual({
      releaseInfoPlistPath: null,
      releaseProjectPbxprojPath: null,
      releaseExpoAppConfigPath: null,
    });
  });

  it("should collect unique watch paths skipping blanks", () => {
    expect(collectVersionWatchPaths(" A ", "", "  A  ")).toEqual(["A"]);
    expect(
      collectVersionWatchPaths("p.plist", "x.pbxproj", "app.json"),
    ).toEqual(["p.plist", "x.pbxproj", "app.json"]);
    expect(collectVersionWatchPaths(null, null, null, "package.json")).toEqual([
      "package.json",
    ]);
  });

  it("should infer kind from legacy with expo precedence", () => {
    expect(
      inferKindAndPathFromLegacyPaths("ios/Info.plist", "x.pbxproj", "app.json"),
    ).toEqual({ kind: "react_native_expo", path: "app.json" });
    expect(inferKindAndPathFromLegacyPaths("ios/Info.plist", "x.pbxproj", null)).toEqual({
      kind: "ios_pbx",
      path: "x.pbxproj",
    });
    expect(inferKindAndPathFromLegacyPaths("ios/Info.plist", null, null)).toEqual({
      kind: "ios_plist",
      path: "ios/Info.plist",
    });
    expect(inferKindAndPathFromLegacyPaths(null, null, null)).toBeNull();
  });
});
