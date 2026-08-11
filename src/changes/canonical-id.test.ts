import { describe, expect, it } from "vitest";

import { execute } from "@/changes/canonical-id.js";

describe("changes/canonical-id execute", () => {
  it("should return the same UUID when canonical identity parts are unchanged", () => {
    const first = execute("change", "workspace-1", "github:acme/app:pull_request:42");
    const second = execute("change", "workspace-1", "github:acme/app:pull_request:42");

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("should return a different UUID when any identity part changes", () => {
    expect(execute("change", "workspace-1", "source-1")).not.toBe(
      execute("change", "workspace-2", "source-1"),
    );
  });
});
