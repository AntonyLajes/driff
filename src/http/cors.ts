import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

export type CorsRegistrationInput =
  | { kind: "off" }
  | { kind: "reflect" }
  | { kind: "allowlist"; origins: readonly string[] };

/** Methods the JSON API uses from browser clients (preflight must list them). */
const BROWSER_API_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

const corsOptions = {
  methods: [...BROWSER_API_METHODS] as string[],
};

export const execute = async (
  server: FastifyInstance,
  input: CorsRegistrationInput,
): Promise<void> => {
  if (input.kind === "off") {
    return;
  }

  if (input.kind === "reflect") {
    await server.register(cors, { origin: true, ...corsOptions });
    return;
  }

  await server.register(cors, {
    origin: [...input.origins],
    ...corsOptions,
  });
};
