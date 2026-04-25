import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { execute } from "@/sources/github/verify.js";

describe("sources/github/verify execute", () => {
  it("should return true when signature is valid", () => {
    const payload = JSON.stringify({ hello: "world" });
    const signatureHeader = `sha256=${createHmac("sha256", "top-secret")
      .update(payload)
      .digest("hex")}`;

    const result = execute({
      payload,
      signatureHeader,
      secret: "top-secret",
    });

    expect(result).toBe(true);
  });

  it("should return false when signature header is missing", () => {
    const result = execute({
      payload: "{}",
      signatureHeader: undefined,
      secret: "top-secret",
    });

    expect(result).toBe(false);
  });

  it("should return false when signature prefix is invalid", () => {
    const result = execute({
      payload: "{}",
      signatureHeader: "sha1=abc",
      secret: "top-secret",
    });

    expect(result).toBe(false);
  });

  it("should return false when signature does not match", () => {
    const result = execute({
      payload: "{}",
      signatureHeader:
        "sha256=66c42f5f09f0f4edc9f65debba4f4c853bd254c4b2b7fc0f87f67aa6447d8f4e",
      secret: "top-secret",
    });

    expect(result).toBe(false);
  });
});
