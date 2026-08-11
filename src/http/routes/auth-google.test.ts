import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/teams/ensure-personal-team.js", () => ({ ensurePersonalTeam: vi.fn() }));

import { verifySessionJwt } from "@/auth/session-jwt.js";
import {
  buildGoogleOAuthRegistrationInput,
  handler,
} from "@/http/routes/auth-google.js";
import { ensurePersonalTeam } from "@/teams/ensure-personal-team.js";

describe("http/routes/auth-google", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];
  const jwtSecret = "o".repeat(40);

  const register = async (db: unknown = {}, nodeEnv = "test") => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: db as never,
      clientId: "google-client",
      clientSecret: "google-secret",
      jwtSecret,
      publicApiUrl: "https://api.driff.dev",
      frontendUrl: "https://driff.dev",
      nodeEnv,
    });
    await server.ready();
    return server;
  };

  const beginOAuth = async (server: Awaited<ReturnType<typeof register>>) => {
    const start = await server.inject({ method: "GET", url: "/auth/google/start" });
    const cookie = String(start.headers["set-cookie"]);
    const state = new URL(String(start.headers.location)).searchParams.get("state");
    if (state === null) throw new Error("missing state in test");
    return { cookie, state };
  };

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
    vi.restoreAllMocks();
    vi.mocked(ensurePersonalTeam).mockReset();
  });

  it("only builds registration input from a complete environment", () => {
    expect(
      buildGoogleOAuthRegistrationInput(
        { GOOGLE_OAUTH_CLIENT_ID: undefined } as never,
        {} as never,
      ),
    ).toBeUndefined();

    const db = {} as never;
    expect(
      buildGoogleOAuthRegistrationInput(
        {
          GOOGLE_OAUTH_CLIENT_ID: "id",
          GOOGLE_OAUTH_CLIENT_SECRET: "secret",
          AUTH_JWT_SECRET: jwtSecret,
          AUTH_PUBLIC_URL: "https://api.driff.dev///",
          FRONTEND_URL: "https://driff.dev/",
          NODE_ENV: "production",
        } as never,
        db,
      ),
    ).toEqual({
      db,
      clientId: "id",
      clientSecret: "secret",
      jwtSecret,
      publicApiUrl: "https://api.driff.dev",
      frontendUrl: "https://driff.dev",
      nodeEnv: "production",
    });
  });

  it("starts Google OAuth with a short-lived state cookie", async () => {
    const server = await register({}, "production");
    const response = await server.inject({ method: "GET", url: "/auth/google/start" });
    const location = new URL(String(response.headers.location));

    expect(response.statusCode).toBe(302);
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://api.driff.dev/auth/google/callback",
    );
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("state")).toMatch(/^[a-f0-9]{48}$/);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("Secure");
  });

  it("redirects provider, missing, invalid and malformed state errors safely", async () => {
    const server = await register();

    const provider = await server.inject({
      method: "GET",
      url: "/auth/google/callback?error=access_denied",
    });
    const missing = await server.inject({
      method: "GET",
      url: "/auth/google/callback",
    });
    const invalid = await server.inject({
      method: "GET",
      url: "/auth/google/callback?code=x&state=wrong",
      headers: { cookie: "driff_google_oauth_state=expected" },
    });
    const malformed = await server.inject({
      method: "GET",
      url: "/auth/google/callback?code=x&state=wrong",
      headers: { cookie: "ignored; driff_google_oauth_state=%E0%A4%A; other=x" },
    });

    expect(provider.headers.location).toBe(
      "https://driff.dev/login?oauth_error=access_denied",
    );
    expect(missing.headers.location).toContain("missing_code_or_state");
    expect(invalid.headers.location).toContain("invalid_state");
    expect(malformed.headers.location).toContain("invalid_state");
  });

  it("creates a session after upserting the Google user and personal team", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const returning = vi.fn(async () => [{ id: userId }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const server = await register({ insert: vi.fn(() => ({ values })) });
    const { cookie, state } = await beginOAuth(server);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "google-access" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sub: "google-42",
            email: "antony@example.com",
            name: "Antony",
            picture: "https://example.com/avatar.png",
          }),
          { status: 200 },
        ),
      );

    const response = await server.inject({
      method: "GET",
      url: `/auth/google/callback?code=code&state=${state}`,
      headers: { cookie },
    });
    const location = new URL(String(response.headers.location));
    const sessionToken = location.searchParams.get("token");

    expect(location.origin + location.pathname).toBe(
      "https://driff.dev/oauth/google/callback",
    );
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        googleSub: "google-42",
        email: "antony@example.com",
        name: "Antony",
      }),
    );
    expect(ensurePersonalTeam).toHaveBeenCalledWith(expect.anything(), {
      userId,
      name: "Antony",
      email: "antony@example.com",
    });
    expect(verifySessionJwt(sessionToken ?? "", jwtSecret)).toMatchObject({
      userId,
      email: "antony@example.com",
    });
  });

  it("reports a missing row after a successful provider exchange", async () => {
    const returning = vi.fn(async () => []);
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => ({ returning })),
        })),
      })),
    };
    const server = await register(db);
    const { cookie, state } = await beginOAuth(server);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "google-access" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sub: "42", email: "a@example.com" }), {
          status: 200,
        }),
      );

    const response = await server.inject({
      method: "GET",
      url: `/auth/google/callback?code=code&state=${state}`,
      headers: { cookie },
    });

    expect(response.headers.location).toContain("user_upsert_failed");
    expect(ensurePersonalTeam).not.toHaveBeenCalled();
  });

  it("hides token and userinfo exchange failures behind one public error", async () => {
    const server = await register();
    const first = await beginOAuth(server);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("provider unavailable", { status: 502 }),
    );

    const tokenFailure = await server.inject({
      method: "GET",
      url: `/auth/google/callback?code=code&state=${first.state}`,
      headers: { cookie: first.cookie },
    });

    const second = await beginOAuth(server);
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ email: "missing-sub@example.com" }), {
          status: 200,
        }),
      );
    const userFailure = await server.inject({
      method: "GET",
      url: `/auth/google/callback?code=code&state=${second.state}`,
      headers: { cookie: second.cookie },
    });

    expect(tokenFailure.headers.location).toContain("oauth_exchange_failed");
    expect(userFailure.headers.location).toContain("oauth_exchange_failed");
  });
});
