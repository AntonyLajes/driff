import { describe, expect, it } from "vitest";

import { execute } from "@/destinations/notion/blocks.js";
import type { PRSummary } from "@/destinations/destination.js";

const summary: PRSummary = {
  repo: "acme/mobile-app",
  prNumber: 10,
  title: "feat: add checkout improvements",
  author: "octocat",
  mergedAt: new Date("2026-04-25T19:00:00Z"),
  summaryUserFacing: "Checkout is faster and clearer.",
  summaryTechnical: "Refactors payment service and route handlers.",
  category: "feature",
  area: "checkout",
  prUrl: "https://github.com/acme/mobile-app/pull/10",
};

describe("destinations/notion/blocks execute", () => {
  it("should build user-facing and technical block sections", () => {
    const blocks = execute(summary);

    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({
      type: "heading_2",
      heading_2: {
        rich_text: [{ text: { content: "User-facing" } }],
      },
    });
    expect(blocks[1]).toMatchObject({
      type: "paragraph",
      paragraph: {
        rich_text: [{ text: { content: "Checkout is faster and clearer." } }],
      },
    });
    expect(blocks[2]).toMatchObject({
      type: "heading_2",
      heading_2: {
        rich_text: [{ text: { content: "Technical" } }],
      },
    });
    expect(blocks[3]).toMatchObject({
      type: "paragraph",
      paragraph: {
        rich_text: [{ text: { content: "Refactors payment service and route handlers." } }],
      },
    });
  });
});
