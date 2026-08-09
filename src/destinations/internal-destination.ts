import type { Destination } from "@/destinations/destination.js";

/**
 * Keeps Driff's own history as the primary destination.
 *
 * External destinations such as Notion are optional delivery channels. Job
 * handlers persist the generated summary immediately after this adapter
 * returns, so an empty page id correctly represents "stored in Driff only".
 */
export const internalDestination: Destination = {
  publishPR: async () => ({ pageId: "" }),
  publishRelease: async () => ({ pageId: "" }),
  publishPush: async () => ({ pageId: "" }),
};
