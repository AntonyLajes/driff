import { and, eq } from "drizzle-orm";

import { openSecret } from "@/auth/token-aes.js";
import type { Database } from "@/db/client.js";
import { workspaceDestinationsTable } from "@/db/schema.js";
import { execute as createComposite } from "@/destinations/composite-destination.js";
import type { Destination } from "@/destinations/destination.js";
import {
  destinationTypeSchema,
  getDestination,
  isImplementedDestination,
} from "@/destinations/registry.js";

/**
 * Loads all enabled, implemented destinations for a workspace, decrypts each token, and wraps
 * them in a fan-out composite. Returns null when the workspace has no usable destination.
 */
export const loadWorkspaceDestination = async (
  db: Database,
  workspaceId: string,
  jwtSecret: string,
): Promise<Destination | null> => {
  const rows = await db
    .select()
    .from(workspaceDestinationsTable)
    .where(
      and(
        eq(workspaceDestinationsTable.workspaceId, workspaceId),
        eq(workspaceDestinationsTable.enabled, true),
      ),
    );

  const children: { label: string; destination: Destination }[] = [];
  for (const row of rows) {
    const parsed = destinationTypeSchema.safeParse(row.type);
    if (!parsed.success || !isImplementedDestination(parsed.data)) {
      continue;
    }
    if (!row.secretCiphertext) {
      continue;
    }
    let token: string;
    try {
      token = openSecret(row.secretCiphertext, jwtSecret);
    } catch {
      continue;
    }
    try {
      const destination = getDestination(parsed.data, {
        token,
        config: row.config ?? null,
      });
      children.push({ label: parsed.data, destination });
    } catch {
      continue;
    }
  }

  if (children.length === 0) {
    return null;
  }
  return createComposite({ children });
};
