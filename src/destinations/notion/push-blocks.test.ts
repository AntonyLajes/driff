import { describe, expect, it } from "vitest";

import type { PushSummary } from "@/destinations/destination.js";
import { execute } from "@/destinations/notion/push-blocks.js";

describe("destinations/notion/push-blocks", () => {
  it("renders user-facing and technical summaries as Notion blocks", () => {
    const summary = {
      summaryUserFacing: "Customers can now retry a payment.",
      summaryTechnical: "Adds idempotent retry handling.",
    } as PushSummary;

    expect(execute(summary)).toEqual([
      expect.objectContaining({ type: "heading_2" }),
      expect.objectContaining({
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: summary.summaryUserFacing } }] },
      }),
      expect.objectContaining({ type: "heading_2" }),
      expect.objectContaining({
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: summary.summaryTechnical } }] },
      }),
    ]);
  });
});
