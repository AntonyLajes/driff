import { eq } from "drizzle-orm";

import { openSecret } from "@/auth/token-aes.js";
import type { Database } from "@/db/client.js";
import { userGithubAccountsTable } from "@/db/schema.js";

export const loadUserGithubAccessToken = async (
  db: Database,
  userId: string,
  jwtSecret: string,
): Promise<string | null> => {
  const rows = await db
    .select()
    .from(userGithubAccountsTable)
    .where(eq(userGithubAccountsTable.userId, userId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return openSecret(row.accessTokenCiphertext, jwtSecret);
};
