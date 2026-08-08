import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { execute } from "@/lab/verify-lab.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/expo-three-version-history.json", import.meta.url),
);

describe("lab/verify-lab", () => {
  it("should verify a scenario file and format the result", async () => {
    await expect(execute({ filePath: fixturePath })).resolves.toBe(
      "Verified expo-three-version-history: 3 events produced 4 expected jobs.",
    );
  });

  it("should fail when the scenario file is missing", async () => {
    await expect(
      execute({ filePath: `${fixturePath}.missing` }),
    ).rejects.toThrow();
  });
});
