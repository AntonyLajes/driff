import { describe, expect, it } from "vitest";

import type { ReleaseNotesSummary } from "@/destinations/destination.js";
import { execute, toMarkdown } from "@/destinations/notion/release-blocks.js";

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
      changelog: "High-level changes.",
      sections: [{ label: "Empty", items: [] }],
    };
    const blocks = execute(summary);
    expect(
      blocks.some(
        (b) =>
          "heading_2" in b &&
          b.heading_2.rich_text[0]?.text.content === "Empty",
      ),
    ).toBe(false);
  });

  it("should build replacement markdown without empty sections", () => {
    const summary: ReleaseNotesSummary = {
      title: "2.0.0",
      repo: "o/r",
      branch: "main",
      newVersionKey: "2.0.0+2",
      previousVersionKey: "1.0.0+1",
      shortVersion: "2.0.0",
      buildVersion: "2",
      compareUrl: "https://c",
      prNumbers: [10],
      changelog: "A clearer checkout.",
      sections: [
        { label: "Features", items: ["Add express checkout."] },
        { label: "Empty", items: [] },
      ],
    };

    expect(toMarkdown(summary)).toBe(
      "## Changelog\n\nA clearer checkout.\n\n## Features\n- Add express checkout.",
    );
  });
});
