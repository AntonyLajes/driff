import { describe, expect, it, vi } from "vitest";

import type { Destination } from "@/destinations/destination.js";
import { execute } from "@/destinations/optional-destination.js";

const summary = {} as never;

describe("optional destination", () => {
  it("preserves successful external page identifiers", async () => {
    const destination: Destination = {
      publishPR: vi.fn(async () => ({ pageId: "pr-page" })),
      publishRelease: vi.fn(async () => ({ pageId: "release-page" })),
      publishPush: vi.fn(async () => ({ pageId: "push-page" })),
    };
    const optional = execute({ destination });

    await expect(optional.publishPR(summary)).resolves.toEqual({ pageId: "pr-page" });
    await expect(optional.publishRelease(summary)).resolves.toEqual({
      pageId: "release-page",
    });
    await expect(optional.publishPush(summary)).resolves.toEqual({ pageId: "push-page" });
  });

  it.each([
    ["publishPR", "publishPR"],
    ["publishRelease", "publishRelease"],
    ["publishPush", "publishPush"],
  ] as const)("turns a %s failure into an internal-only delivery", async (method, kind) => {
    const failure = new Error("destination unavailable");
    const destination: Destination = {
      publishPR: vi.fn(async () => {
        throw failure;
      }),
      publishRelease: vi.fn(async () => {
        throw failure;
      }),
      publishPush: vi.fn(async () => {
        throw failure;
      }),
    };
    const logError = vi.fn();
    const optional = execute({ destination, logError });

    await expect(optional[method](summary)).resolves.toEqual({ pageId: "" });
    expect(logError).toHaveBeenCalledWith(kind, failure);
  });

  it("logs through the default diagnostic path", async () => {
    const failure = new Error("destination unavailable");
    const destination: Destination = {
      publishPR: vi.fn(async () => {
        throw failure;
      }),
      publishRelease: vi.fn(),
      publishPush: vi.fn(),
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(execute({ destination }).publishPR(summary)).resolves.toEqual({
      pageId: "",
    });
    expect(warning).toHaveBeenCalledWith(
      "optional destination failed to publishPR:",
      failure,
    );
  });
});
