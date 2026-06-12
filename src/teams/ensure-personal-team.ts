import { eq } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { isUniqueViolation } from "@/db/pg-error.js";
import { teamMembersTable, teamsTable } from "@/db/schema.js";
import {
  isLegacyPersonalSlug,
  personalTeamBaseSlug,
} from "@/teams/personal-team-slug.js";

const randomSuffix = (): string => Math.random().toString(36).slice(2, 8);

/**
 * Ensures the user's personal team exists (id === userId), carries a friendly
 * URL slug (e.g. "antony", not "personal-<uuid>"), and that the user owns it.
 * Idempotent on every login; upgrades the legacy slug in place. Best-effort:
 * slug collisions retry with a suffix; never throws into the OAuth flow.
 */
export const ensurePersonalTeam = async (
  db: Database,
  input: { userId: string; name: string | null; email: string },
): Promise<void> => {
  const base = personalTeamBaseSlug(input.name, input.email);
  const name = input.name?.trim() || input.email.split("@")[0] || "Personal";

  const existing = await db
    .select({ slug: teamsTable.slug })
    .from(teamsTable)
    .where(eq(teamsTable.id, input.userId))
    .limit(1);

  const trySlugs = (run: (slug: string) => Promise<void>) =>
    (async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
        try {
          await run(slug);
          return;
        } catch (err) {
          if (isUniqueViolation(err)) continue;
          throw err;
        }
      }
    })();

  if (existing[0] === undefined) {
    await trySlugs((slug) =>
      db
        .insert(teamsTable)
        .values({ id: input.userId, name, slug, isPersonal: true })
        .then(() => undefined),
    );
  } else if (isLegacyPersonalSlug(existing[0].slug)) {
    await trySlugs((slug) =>
      db
        .update(teamsTable)
        .set({ slug, updatedAt: new Date() })
        .where(eq(teamsTable.id, input.userId))
        .then(() => undefined),
    );
  }

  await db
    .insert(teamMembersTable)
    .values({ teamId: input.userId, userId: input.userId, role: "owner" })
    .onConflictDoNothing();
};
