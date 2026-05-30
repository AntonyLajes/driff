import { describe, expect, it } from "vitest";

import {
  signDestinationOAuthState,
  verifyDestinationOAuthState,
} from "@/auth/destination-oauth-state.js";

const secret = "a".repeat(32);

describe("auth/destination-oauth-state", () => {
  it("round-trips userId + workspaceId", () => {
    const state = signDestinationOAuthState({ userId: "u1", workspaceId: "w1", secret });
    expect(verifyDestinationOAuthState(state, secret)).toEqual({
      userId: "u1",
      workspaceId: "w1",
    });
  });

  it("rejects a tampered or wrong-secret state", () => {
    const state = signDestinationOAuthState({ userId: "u1", workspaceId: "w1", secret });
    expect(verifyDestinationOAuthState(state, "b".repeat(32))).toBeNull();
    expect(verifyDestinationOAuthState(`${state}x`, secret)).toBeNull();
    expect(verifyDestinationOAuthState("garbage", secret)).toBeNull();
  });
});
