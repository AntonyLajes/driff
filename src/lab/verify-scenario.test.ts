import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { execute } from "@/lab/verify-scenario.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/expo-three-version-history.json", import.meta.url),
);

const loadFixture = async (): Promise<unknown> =>
  JSON.parse(await readFile(fixturePath, "utf8")) as unknown;

describe("lab/verify-scenario", () => {
  it("should verify expected jobs through the real webhook handler", async () => {
    await expect(execute(await loadFixture())).resolves.toEqual({
      scenarioId: "expo-three-version-history",
      eventCount: 3,
      expectedJobCount: 4,
    });
  });

  it("should report the delivery when actual jobs differ from the fixture", async () => {
    const fixture = await loadFixture();
    if (
      fixture === null ||
      typeof fixture !== "object" ||
      Array.isArray(fixture)
    ) {
      throw new Error("Expected fixture object.");
    }
    const record = fixture as Record<string, unknown>;
    const events = record.events;
    if (!Array.isArray(events) || events[0] === undefined) {
      throw new Error("Expected fixture events.");
    }
    const firstEvent = events[0];
    if (
      firstEvent === null ||
      typeof firstEvent !== "object" ||
      Array.isArray(firstEvent)
    ) {
      throw new Error("Expected first fixture event.");
    }

    const changed = {
      ...record,
      events: [
        { ...firstEvent, expectedJobs: ["process_push"] },
        ...events.slice(1),
      ],
    };

    await expect(execute(changed)).rejects.toThrow(
      /lab-expo-pr-101 expected jobs \[process_push\] but enqueued \[process_pr\]/u,
    );
  });

  it("should reject an invalid scenario before creating the server", async () => {
    await expect(execute({ schemaVersion: 99 })).rejects.toThrow();
  });
});
