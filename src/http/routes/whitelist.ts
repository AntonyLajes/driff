import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Env } from "@/config/env.js";
import type { Database } from "@/db/client.js";
import { whitelistSignupsTable } from "@/db/schema.js";
import { sendWhitelistEmail } from "@/email/send-whitelist-email.js";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null));

const whitelistBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  team: z.string().trim().min(1).max(120),
  teamSize: optionalText(40),
  role: optionalText(80),
  githubOrg: optionalText(200),
});

export interface WhitelistRegistrationInput {
  db: Database;
  /** Resend config (optional — signup still persists without it). */
  resendApiKey?: string;
  resendFrom?: string;
}

/** Builds the public-whitelist registration input from env (db injected by caller). */
export const buildWhitelistRegistrationInput = (
  env: Env,
  db: Database,
): WhitelistRegistrationInput => ({
  db,
  resendApiKey: env.RESEND_API_KEY,
  resendFrom: env.RESEND_FROM,
});

/** Public landing-page beta whitelist capture: `POST /api/whitelist`. */
export const handler = async (
  instance: FastifyInstance,
  input: WhitelistRegistrationInput,
): Promise<void> => {
  instance.post("/api/whitelist", async (request, reply) => {
    const parsed = whitelistBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: "invalid_body", details: parsed.error.flatten() });
    }

    const data = parsed.data;
    const inserted = await input.db
      .insert(whitelistSignupsTable)
      .values({
        name: data.name,
        email: data.email.toLowerCase(),
        team: data.team,
        teamSize: data.teamSize,
        role: data.role,
        githubOrg: data.githubOrg,
      })
      .onConflictDoNothing()
      .returning({ id: whitelistSignupsTable.id });

    const isNew = inserted.length > 0;
    if (isNew) {
      // Best-effort: confirmation email must not block (or fail) the signup.
      void sendWhitelistEmail({
        apiKey: input.resendApiKey,
        from: input.resendFrom,
        to: data.email,
        name: data.name,
      }).catch(() => undefined);
    }

    return reply.status(201).send({ ok: true, alreadyRegistered: !isNew });
  });
};
