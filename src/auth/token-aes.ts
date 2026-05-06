import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

const deriveKey = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();

/**
 * Seals a short secret (e.g. GitHub OAuth access token) using AES-256-GCM.
 * Format: base64url(iv || authTag || ciphertext).
 */
export const sealSecret = (plaintext: string, secret: string): string => {
  const iv = randomBytes(12);
  const key = deriveKey(secret);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
};

export const openSecret = (sealed: string, secret: string): string => {
  const buf = Buffer.from(sealed, "base64url");
  if (buf.length < 12 + 16) {
    throw new Error("invalid_sealed_blob");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key = deriveKey(secret);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
};
