import { createHmac, timingSafeEqual } from "node:crypto";

const b64uEncode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
const b64uDecode = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

/**
 * Signs the OAuth state for connecting an output destination. Carries the user and the
 * workspace the destination will be attached to.
 */
export const signDestinationOAuthState = (input: {
  userId: string;
  workspaceId: string;
  secret: string;
}): string => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const payload = b64uEncode(JSON.stringify({ u: input.userId, w: input.workspaceId, e: exp }));
  const signature = createHmac("sha256", input.secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};

export const verifyDestinationOAuthState = (
  state: string,
  secret: string,
): { userId: string; workspaceId: string } | null => {
  const parts = state.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  if (!payload || !signature) {
    return null;
  }
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  let body: { u?: string; w?: string; e?: number };
  try {
    body = JSON.parse(b64uDecode(payload)) as { u?: string; w?: string; e?: number };
  } catch {
    return null;
  }
  if (typeof body.u !== "string" || typeof body.w !== "string" || typeof body.e !== "number") {
    return null;
  }
  if (body.e <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return { userId: body.u, workspaceId: body.w };
};
