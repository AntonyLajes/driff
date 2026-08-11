import type {
  Destination,
  PRSummary,
  PushSummary,
  ReleaseNotesSummary,
} from "@/destinations/destination.js";

export interface ExecuteInput {
  destination: Destination;
  logError?: (kind: string, error: unknown) => void;
}

export const publishBestEffort = async (
  kind: string,
  operation: () => Promise<{ pageId: string }>,
  logError: (kind: string, error: unknown) => void = (failedKind, error) => {
    console.warn(`optional destination failed to ${failedKind}:`, error);
  },
): Promise<{ pageId: string }> => {
  try {
    return await operation();
  } catch (error) {
    logError(kind, error);
    return { pageId: "" };
  }
};

/**
 * Makes an external delivery best-effort. Driff's canonical history is the product;
 * a disconnected or temporarily unavailable destination must never block persistence.
 */
export const execute = (input: ExecuteInput): Destination => {
  return {
    publishPR: (summary: PRSummary) =>
      publishBestEffort("publishPR", () => input.destination.publishPR(summary), input.logError),
    publishRelease: (summary: ReleaseNotesSummary) =>
      publishBestEffort(
        "publishRelease",
        () => input.destination.publishRelease(summary),
        input.logError,
      ),
    publishPush: (summary: PushSummary) =>
      publishBestEffort(
        "publishPush",
        () => input.destination.publishPush(summary),
        input.logError,
      ),
  };
};
