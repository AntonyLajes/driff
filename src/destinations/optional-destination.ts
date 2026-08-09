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

/**
 * Makes an external delivery best-effort. Driff's canonical history is the product;
 * a disconnected or temporarily unavailable destination must never block persistence.
 */
export const execute = (input: ExecuteInput): Destination => {
  const logError =
    input.logError ??
    ((kind, error) => {
      console.warn(`optional destination failed to ${kind}:`, error);
    });

  const publish = async (
    kind: string,
    operation: () => Promise<{ pageId: string }>,
  ): Promise<{ pageId: string }> => {
    try {
      return await operation();
    } catch (error) {
      logError(kind, error);
      return { pageId: "" };
    }
  };

  return {
    publishPR: (summary: PRSummary) =>
      publish("publishPR", () => input.destination.publishPR(summary)),
    publishRelease: (summary: ReleaseNotesSummary) =>
      publish("publishRelease", () => input.destination.publishRelease(summary)),
    publishPush: (summary: PushSummary) =>
      publish("publishPush", () => input.destination.publishPush(summary)),
  };
};
