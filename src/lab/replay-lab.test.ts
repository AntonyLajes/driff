import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { execute as replayScenario } from "@/lab/replay-scenario.js";

vi.mock("@/lab/replay-scenario.js", () => ({
  execute: vi.fn(),
}));

import { execute } from "@/lab/replay-lab.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/expo-three-version-history.json", import.meta.url),
);
const replayScenarioMock = vi.mocked(replayScenario);

describe("lab/replay-lab", () => {
  beforeEach(() => {
    replayScenarioMock.mockReset();
    replayScenarioMock.mockResolvedValue({
      scenarioId: "expo-three-version-history",
      events: [
        { deliveryId: "one", eventType: "push", status: 200 },
        { deliveryId: "two", eventType: "push", status: 200 },
      ],
    });
  });

  it("should replay a fixture against the default localhost target", async () => {
    await expect(
      execute({
        args: [fixturePath],
        env: { GITHUB_WEBHOOK_SECRET: "lab-secret" },
      }),
    ).resolves.toBe(
      "Replayed expo-three-version-history: 2 events accepted by http://localhost:3000/webhooks/github.",
    );

    expect(replayScenarioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: "http://localhost:3000/webhooks/github",
        webhookSecret: "lab-secret",
        allowedRemoteHosts: [],
        confirmDevelopment: false,
      }),
    );
  });

  it("should forward the remote allowlist and explicit confirmation", async () => {
    await execute({
      args: [
        fixturePath,
        "https://driff-dev.example/webhooks/github",
        "--confirm-development",
      ],
      env: {
        GITHUB_WEBHOOK_SECRET: "lab-secret",
        DRIFF_LAB_ALLOWED_HOSTS: "driff-dev.example, another.example",
      },
    });

    expect(replayScenarioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: "https://driff-dev.example/webhooks/github",
        allowedRemoteHosts: ["driff-dev.example", "another.example"],
        confirmDevelopment: true,
      }),
    );
  });

  it("should reject missing arguments or webhook secret", async () => {
    await expect(execute({ args: [], env: {} })).rejects.toThrow(/Usage/u);
    await expect(execute({ args: [fixturePath], env: {} })).rejects.toThrow(
      /GITHUB_WEBHOOK_SECRET/u,
    );
    await expect(
      execute({
        args: [fixturePath, "one", "two"],
        env: { GITHUB_WEBHOOK_SECRET: "secret" },
      }),
    ).rejects.toThrow(/Usage/u);
  });
});
