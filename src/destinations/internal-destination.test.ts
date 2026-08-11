import { describe, expect, it } from "vitest";

import { internalDestination } from "@/destinations/internal-destination.js";

describe("destinations/internal-destination", () => {
  it("accepts every summary type without requiring an external integration", async () => {
    await expect(internalDestination.publishPR({} as never)).resolves.toEqual({
      pageId: "",
    });
    await expect(
      internalDestination.publishRelease({} as never),
    ).resolves.toEqual({ pageId: "" });
    await expect(internalDestination.publishPush({} as never)).resolves.toEqual({
      pageId: "",
    });
  });
});
