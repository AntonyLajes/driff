import { describe, expect, it } from "vitest";

import { signSessionJwt, verifySessionJwt } from "@/auth/session-jwt.js";

describe("auth/session-jwt", () => {
  const secret = "x".repeat(32);

  it("should round-trip sign and verify a JWT", () => {
    const token = signSessionJwt({
      secret,
      userId: "01900000-0000-7000-8000-000000000001",
      email: "ops@example.com",
      expiresInSeconds: 3600,
    });
    const verified = verifySessionJwt(token, secret);
    expect(verified).toEqual({
      userId: "01900000-0000-7000-8000-000000000001",
      email: "ops@example.com",
    });
  });

  it("should reject tampered payload", () => {
    const token = signSessionJwt({
      secret,
      userId: "01900000-0000-7000-8000-000000000001",
      email: "ops@example.com",
      expiresInSeconds: 3600,
    });
    const [h, p, s] = token.split(".");
    const tampered = `${h}.${Buffer.from(
      JSON.stringify({
        sub: "01900000-0000-7000-8000-000000000001",
        email: "evil@example.com",
        typ: "driff_access",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url")}.${s}`;
    expect(verifySessionJwt(tampered, secret)).toBeNull();
  });

  it("should reject wrong secret", () => {
    const token = signSessionJwt({
      secret,
      userId: "01900000-0000-7000-8000-000000000001",
      email: "ops@example.com",
      expiresInSeconds: 3600,
    });
    expect(verifySessionJwt(token, "y".repeat(32))).toBeNull();
  });
});
