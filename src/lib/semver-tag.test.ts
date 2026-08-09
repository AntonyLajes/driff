import { describe, expect, it } from "vitest";

import { parseSemverTag } from "@/lib/semver-tag.js";

describe("parseSemverTag", () => {
  it.each([
    ["v1.2.3", "1.2.3", ""],
    ["1.2.3", "1.2.3", ""],
    ["v2.0.0-rc.1", "2.0.0-rc.1", ""],
    ["1.2.3+build.7", "1.2.3", "build.7"],
  ])("parses %s", (tag, short, build) => {
    expect(parseSemverTag(tag)?.version).toEqual({ short, build });
  });

  it.each(["release", "v1", "1.2", "v01.2.3", "v1.02.3", ""])(
    "rejects %s",
    (tag) => expect(parseSemverTag(tag)).toBeNull(),
  );
});
