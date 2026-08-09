import { describe, expect, it, vi } from "vitest";

import { sealSecret } from "@/auth/token-aes.js";
import { loadUserGithubAccessToken } from "@/github/load-user-github-access-token.js";

const buildDb = (rows: unknown[]) => {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as never, select, limit };
};

describe("github/load-user-github-access-token", () => {
  it("returns null when the user has no GitHub connection", async () => {
    const { db, select } = buildDb([]);

    await expect(
      loadUserGithubAccessToken(db, "user-id", "k".repeat(40)),
    ).resolves.toBeNull();
    expect(select).toHaveBeenCalledOnce();
  });

  it("decrypts the connected user's access token", async () => {
    const secret = "s".repeat(40);
    const { db } = buildDb([
      { accessTokenCiphertext: sealSecret("github-token", secret) },
    ]);

    await expect(loadUserGithubAccessToken(db, "user-id", secret)).resolves.toBe(
      "github-token",
    );
  });
});
