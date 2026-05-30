import { z } from "zod";

import type { Destination } from "@/destinations/destination.js";
import { execute as createNotionDestination } from "@/destinations/notion/notion-destination.js";

/**
 * Output destinations the data model knows about. Adding one = enum value here +
 * a `getDestination` case + a `Destination` implementation.
 */
export const DESTINATION_TYPES = ["notion", "slack", "whatsapp"] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export const destinationTypeSchema = z.enum(DESTINATION_TYPES);

/** Destination types with a working runtime implementation today. */
export const IMPLEMENTED_DESTINATION_TYPES: readonly DestinationType[] = ["notion"];

export const isImplementedDestination = (type: DestinationType): boolean =>
  IMPLEMENTED_DESTINATION_TYPES.includes(type);

export class UnsupportedDestinationError extends Error {
  constructor(public readonly type: string) {
    super(`unsupported_destination:${type}`);
    this.name = "UnsupportedDestinationError";
  }
}

/** Non-secret per-type config plus the (already-decrypted) provider token. */
export interface DestinationBuildInput {
  token: string;
  config: Record<string, unknown> | null;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * Builds a `Destination` for the given type. Only Notion is wired today; other known
 * types throw `UnsupportedDestinationError` until implemented.
 */
export const getDestination = (
  type: DestinationType,
  input: DestinationBuildInput,
): Destination => {
  switch (type) {
    case "notion": {
      const config = input.config ?? {};
      return createNotionDestination({
        token: input.token,
        databaseId: asString(config.prDatabaseId),
        releasesDatabaseId: asString(config.releasesDatabaseId),
        pushesDatabaseId: asString(config.pushesDatabaseId),
      });
    }
    default:
      throw new UnsupportedDestinationError(type);
  }
};
