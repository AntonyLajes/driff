import { createHmac, timingSafeEqual } from "node:crypto";

const base64UrlEncode = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64url");

const base64UrlDecode = (value: string): string =>
  Buffer.from(value, "base64url").toString("utf8");

export interface SignSessionJwtInput {
  secret: string;
  userId: string;
  email: string;
  /** Seconds from issuance (e.g. 60 * 60 * 24 * 7). */
  expiresInSeconds: number;
}

export const signSessionJwt = (input: SignSessionJwtInput): string => {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: input.userId,
      email: input.email,
      typ: "driff_access",
      iat: now,
      exp: now + input.expiresInSeconds,
    }),
  );
  const signature = createHmac("sha256", input.secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
};

export interface VerifiedSessionJwt {
  userId: string;
  email: string;
}

export const verifySessionJwt = (
  token: string,
  secret: string,
): VerifiedSessionJwt | null => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) {
    return null;
  }
  const expected = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  let body: { sub?: string; email?: string; exp?: number };
  try {
    body = JSON.parse(base64UrlDecode(payload)) as {
      sub?: string;
      email?: string;
      exp?: number;
    };
  } catch {
    return null;
  }
  if (
    typeof body.sub !== "string" ||
    typeof body.email !== "string" ||
    typeof body.exp !== "number"
  ) {
    return null;
  }
  if (body.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return { userId: body.sub, email: body.email };
};
