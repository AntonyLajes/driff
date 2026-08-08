import { createHash } from "node:crypto";

/** Derives a stable UUID-shaped identifier so retried projections converge on one row. */
export const execute = (...parts: string[]): string => {
  const digest = createHash("sha256").update(["driff:v1", ...parts].join("\0")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};
