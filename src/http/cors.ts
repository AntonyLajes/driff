import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

export type CorsRegistrationInput =
  | { kind: "off" }
  | { kind: "reflect" }
  | { kind: "allowlist"; origins: readonly string[] };

export const execute = async (
  server: FastifyInstance,
  input: CorsRegistrationInput,
): Promise<void> => {
  if (input.kind === "off") {
    return;
  }

  if (input.kind === "reflect") {
    await server.register(cors, { origin: true });
    return;
  }

  await server.register(cors, {
    origin: [...input.origins],
  });
};
