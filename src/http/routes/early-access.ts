import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Database } from "@/db/client.js";
import { earlyAccessSignupsTable } from "@/db/schema.js";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null));

const earlyAccessBodySchema = z.object({
  email: z.string().trim().email().max(254),
  locale: optionalText(10),
  /** Honeypot: hidden field humans leave empty; bots fill it. */
  website: optionalText(200),
});

export interface EarlyAccessRegistrationInput {
  db: Database;
}

/** Builds the early-access registration input (db injected by caller). */
export const buildEarlyAccessRegistrationInput = (
  db: Database,
): EarlyAccessRegistrationInput => ({ db });

/** Public landing-page early-access email capture: `POST /api/early-access`. */
export const handler = async (
  instance: FastifyInstance,
  input: EarlyAccessRegistrationInput,
): Promise<void> => {
  instance.post("/api/early-access", async (request, reply) => {
    const parsed = earlyAccessBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: "invalid_body", details: parsed.error.flatten() });
    }

    const data = parsed.data;

    // Honeypot tripped → almost certainly a bot. Pretend success, store nothing.
    if (data.website) {
      return reply.status(201).send({ ok: true, alreadyRegistered: false });
    }

    const inserted = await input.db
      .insert(earlyAccessSignupsTable)
      .values({
        email: data.email.toLowerCase(),
        locale: data.locale,
      })
      .onConflictDoNothing()
      .returning({ id: earlyAccessSignupsTable.id });

    return reply
      .status(201)
      .send({ ok: true, alreadyRegistered: inserted.length === 0 });
  });
};
