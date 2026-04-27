import { describe, expect, it } from "vitest";

import type { ReleaseNotesSummary } from "@/destinations/destination.js";
import { execute } from "@/destinations/notion/release-blocks.js";

describe("destinations/notion/release-blocks execute", () => {
  it("should skip empty section item lists", () => {
    const summary: ReleaseNotesSummary = {
      title: "t",
      repo: "o/r",
      branch: "d",
      newVersionKey: "1+1",
      previousVersionKey: null,
      shortVersion: "1",
      buildVersion: "1",
      compareUrl: "https://c",
      prNumbers: [],
      userFacing: "u",
      technical: "tech",
      sections: [{ label: "Empty", items: [] }],
    };
    const blocks = execute(summary);
    expect(blocks.some((b) => "heading_2" in b && b.heading_2.rich_text[0]?.text.content === "Empty")).toBe(
      false,
    );
  });
});
