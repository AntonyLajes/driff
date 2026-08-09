import { describe, expect, it, vi } from "vitest";

import { sealSecret } from "@/auth/token-aes.js";
import { loadWorkspaceDestination } from "@/destinations/load-workspace-destinations.js";

const secret = "d".repeat(40);

const buildDb = (rows: unknown[]) => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
  })),
});

describe("destinations/load-workspace-destinations", () => {
  it("returns null when there are no usable enabled destinations", async () => {
    const db = buildDb([
      { type: "unknown", secretCiphertext: sealSecret("token", secret), config: null },
      { type: "slack", secretCiphertext: sealSecret("token", secret), config: null },
      { type: "notion", secretCiphertext: null, config: null },
      { type: "notion", secretCiphertext: "invalid-cipher", config: null },
    ]);

    await expect(
      loadWorkspaceDestination(db as never, "workspace-id", secret),
    ).resolves.toBeNull();
  });

  it("builds a working composite from every valid Notion destination", async () => {
    const db = buildDb([
      {
        type: "notion",
        secretCiphertext: sealSecret("notion-token-one", secret),
        config: { prDatabaseId: " pr-db " },
      },
      {
        type: "notion",
        secretCiphertext: sealSecret("notion-token-two", secret),
        config: { releasesDatabaseId: "release-db" },
      },
    ]);

    const destination = await loadWorkspaceDestination(
      db as never,
      "workspace-id",
      secret,
    );

    expect(destination).not.toBeNull();
    expect(destination).toMatchObject({
      publishPR: expect.any(Function),
      publishRelease: expect.any(Function),
      publishPush: expect.any(Function),
    });
  });
});
