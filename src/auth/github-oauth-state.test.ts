import { describe, expect, it } from "vitest";

import { signGithubOAuthState, verifyGithubOAuthState } from "@/auth/github-oauth-state.js";

describe("auth/github-oauth-state", () => {
  const secret = "x".repeat(32);

  it("round-trips user id in signed state", () => {
    const userId = "00000000-0000-4000-8000-000000000001";
    const state = signGithubOAuthState({ userId, secret });
    const verified = verifyGithubOAuthState(state, secret);
    expect(verified).toEqual({ userId });
  });

  it("rejects tampered state", () => {
    const state = signGithubOAuthState({
      userId: "00000000-0000-4000-8000-000000000001",
      secret,
    });
    const tampered = `${state.slice(0, -3)}zzz`;
    expect(verifyGithubOAuthState(tampered, secret)).toBeNull();
  });

  it("rejects wrong secret", () => {
    const state = signGithubOAuthState({
      userId: "00000000-0000-4000-8000-000000000001",
      secret,
    });
    expect(verifyGithubOAuthState(state, "y".repeat(32))).toBeNull();
  });
});
