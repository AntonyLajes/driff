import { describe, expect, it } from "vitest";

import { openSecret, sealSecret } from "@/auth/token-aes.js";

describe("auth/token-aes", () => {
  it("round-trips plaintext", () => {
    const secret = "k".repeat(40);
    const plain = "gho_example_access_token";
    const sealed = sealSecret(plain, secret);
    expect(openSecret(sealed, secret)).toBe(plain);
  });

  it("throws on invalid blob", () => {
    expect(() => openSecret("not-valid", "k".repeat(40))).toThrow();
  });
});
