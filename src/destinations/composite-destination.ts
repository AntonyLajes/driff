import type {
  Destination,
  PRSummary,
  PushSummary,
  ReleaseNotesSummary,
} from "@/destinations/destination.js";

export interface CompositeChild {
  /** Label for logging (e.g. the destination type). */
  label: string;
  destination: Destination;
}

export interface ExecuteInput {
  children: CompositeChild[];
  /** Optional logger; defaults to console.warn. */
  logError?: (label: string, kind: string, error: unknown) => void;
}

/**
 * Fans a single publish out to every configured destination. A failure in one destination
 * is isolated (logged, not rethrown) so it never blocks the others. Returns the `pageId`
 * of the first destination that succeeds (the primary destination in v1).
 */
export const execute = (input: ExecuteInput): Destination => {
  const logError =
    input.logError ??
    ((label, kind, error) => {
      console.warn(`destination "${label}" failed to ${kind}:`, error);
    });

  const fanOut = async (
    kind: string,
    publish: (destination: Destination) => Promise<{ pageId: string }>,
  ): Promise<{ pageId: string }> => {
    let firstPageId: string | null = null;
    let anySucceeded = false;
    for (const child of input.children) {
      try {
        const result = await publish(child.destination);
        anySucceeded = true;
        if (firstPageId === null) {
          firstPageId = result.pageId;
        }
      } catch (error) {
        logError(child.label, kind, error);
      }
    }
    if (!anySucceeded) {
      throw new Error(`All destinations failed to ${kind}.`);
    }
    return { pageId: firstPageId ?? "" };
  };

  return {
    publishPR: (summary: PRSummary) => fanOut("publishPR", (d) => d.publishPR(summary)),
    publishRelease: (summary: ReleaseNotesSummary) =>
      fanOut("publishRelease", (d) => d.publishRelease(summary)),
    publishPush: (summary: PushSummary) => fanOut("publishPush", (d) => d.publishPush(summary)),
  };
};
