import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";

import { signSessionJwt } from "@/auth/session-jwt.js";
import type { Env } from "@/config/env.js";
import type { Database } from "@/db/client.js";
import { usersTable } from "@/db/schema.js";
import { ensurePersonalTeam } from "@/teams/ensure-personal-team.js";

const STATE_COOKIE = "driff_google_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface GoogleOAuthRegistrationInput {
  db: Database;
  clientId: string;
  clientSecret: string;
  jwtSecret: string;
  /** Public API base URL without trailing slash (e.g. http://localhost:3000). */
  publicApiUrl: string;
  /** Front-end origin without trailing slash (e.g. http://localhost:5173). */
  frontendUrl: string;
  nodeEnv: string;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const parseCookies = (header: string | undefined): Record<string, string> => {
  if (header === undefined || header.length === 0) {
    return {};
  }
  const entries: Array<[string, string]> = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    let value: string;
    try {
      value = decodeURIComponent(trimmed.slice(eq + 1).trim());
    } catch {
      continue;
    }
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
};

const exchangeGoogleAuthorizationCode = async (input: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> => {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`google_token_http_${response.status}:${text}`);
  }
  const json = (await response.json()) as { access_token?: string };
  if (typeof json.access_token !== "string") {
    throw new Error("google_token_missing_access_token");
  }
  return json.access_token;
};

const fetchGoogleUserinfo = async (accessToken: string): Promise<{
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}> => {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`google_userinfo_http_${response.status}:${text}`);
  }
  const json = (await response.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  if (typeof json.sub !== "string" || typeof json.email !== "string") {
    throw new Error("google_userinfo_missing_sub_or_email");
  }
  return {
    sub: json.sub,
    email: json.email,
    name: typeof json.name === "string" ? json.name : undefined,
    picture: typeof json.picture === "string" ? json.picture : undefined,
  };
};

export const buildGoogleOAuthRegistrationInput = (
  env: Env,
  db: Database,
): GoogleOAuthRegistrationInput | undefined => {
  if (
    env.GOOGLE_OAUTH_CLIENT_ID === undefined ||
    env.GOOGLE_OAUTH_CLIENT_SECRET === undefined ||
    env.AUTH_JWT_SECRET === undefined ||
    env.AUTH_PUBLIC_URL === undefined ||
    env.FRONTEND_URL === undefined
  ) {
    return undefined;
  }
  return {
    db,
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    jwtSecret: env.AUTH_JWT_SECRET,
    publicApiUrl: trimTrailingSlash(env.AUTH_PUBLIC_URL),
    frontendUrl: trimTrailingSlash(env.FRONTEND_URL),
    nodeEnv: env.NODE_ENV,
  };
};

export const handler = async (
  instance: FastifyInstance,
  input: GoogleOAuthRegistrationInput,
): Promise<void> => {
  const redirectUri = `${input.publicApiUrl}/auth/google/callback`;
  const secureFlag = input.nodeEnv === "production" ? "; Secure" : "";

  instance.get("/auth/google/start", async (request, reply) => {
    if (redirectUri.includes(":5173/auth/google/callback")) {
      request.log.warn(
        {
          redirectUri,
        },
        "Google OAuth redirect_uri targets port 5173 (Vite). Set AUTH_PUBLIC_URL to the Fastify API origin (e.g. http://localhost:3000) and register that redirect URI in Google Cloud Console.",
      );
    }
    request.log.info(
      { redirectUri },
      "google_oauth_authorize: add this exact redirect URI under Authorized redirect URIs in Google Cloud Console (OAuth Web client).",
    );
    const state = randomBytes(24).toString("hex");
    reply.header(
      "Set-Cookie",
      `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Max-Age=600; SameSite=Lax${secureFlag}`,
    );
    const params = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "online",
      include_granted_scopes: "true",
    });
    return reply.redirect(
      `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      302,
    );
  });

  instance.get("/auth/google/callback", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const frontend = input.frontendUrl;

    const redirectWithError = (code: string) => {
      return reply.redirect(
        `${frontend}/login?oauth_error=${encodeURIComponent(code)}`,
        302,
      );
    };

    if (typeof query.error === "string" && query.error.length > 0) {
      return redirectWithError(query.error);
    }

    const code = query.code;
    const state = query.state;
    if (typeof code !== "string" || typeof state !== "string") {
      return redirectWithError("missing_code_or_state");
    }

    const cookies = parseCookies(request.headers.cookie);
    if (cookies[STATE_COOKIE] !== state) {
      return redirectWithError("invalid_state");
    }

    reply.header(
      "Set-Cookie",
      `${STATE_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax${secureFlag}`,
    );

    try {
      const accessToken = await exchangeGoogleAuthorizationCode({
        code,
        redirectUri,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
      });
      const profile = await fetchGoogleUserinfo(accessToken);

      const rows = await input.db
        .insert(usersTable)
        .values({
          googleSub: profile.sub,
          email: profile.email,
          name: profile.name ?? null,
          picture: profile.picture ?? null,
        })
        .onConflictDoUpdate({
          target: usersTable.googleSub,
          set: {
            email: profile.email,
            name: profile.name ?? null,
            picture: profile.picture ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: usersTable.id });

      const userId = rows[0]?.id;
      if (userId === undefined) {
        return redirectWithError("user_upsert_failed");
      }

      // Personal team: id EQUALS the user id (deterministic default context).
      // Ensures a friendly URL slug and ownership; idempotent on re-login.
      await ensurePersonalTeam(input.db, {
        userId,
        name: profile.name ?? null,
        email: profile.email,
      });

      const jwt = signSessionJwt({
        secret: input.jwtSecret,
        userId,
        email: profile.email,
        expiresInSeconds: SESSION_TTL_SECONDS,
      });

      return reply.redirect(
        `${frontend}/oauth/google/callback?token=${encodeURIComponent(jwt)}`,
        302,
      );
    } catch (err) {
      request.log.warn({ err }, "google_oauth_callback_failed");
      return redirectWithError("oauth_exchange_failed");
    }
  });
};
