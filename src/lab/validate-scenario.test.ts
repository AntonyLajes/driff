import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { execute } from "@/lab/validate-scenario.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/expo-three-version-history.json", import.meta.url),
);

describe("lab/validate-scenario", () => {
  it("should summarize a valid scenario file", async () => {
    await expect(execute({ filePath: fixturePath })).resolves.toEqual({
      scenarioId: "expo-three-version-history",
      eventCount: 3,
      expectedJobCount: 4,
    });
  });

  it("should fail when the scenario file does not exist", async () => {
    await expect(
      execute({ filePath: `${fixturePath}.missing` }),
    ).rejects.toThrow();
  });
});
