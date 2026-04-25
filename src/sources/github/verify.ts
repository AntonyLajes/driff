import { createHmac, timingSafeEqual } from "node:crypto";

export interface ExecuteInput {
  payload: string;
  signatureHeader: string | undefined;
  secret: string;
}

export const execute = ({
  payload,
  signatureHeader,
  secret,
}: ExecuteInput): boolean => {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  const receivedSignature = signatureHeader.slice("sha256=".length);

  if (receivedSignature.length !== expectedSignature.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(receivedSignature, "utf8"),
    Buffer.from(expectedSignature, "utf8"),
  );
};
