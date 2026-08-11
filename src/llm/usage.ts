import type { Database } from "@/db/client.js";
import { llmUsageTable } from "@/db/schema.js";

/** Token usage for one LLM summarization call. Metering only — no enforcement. */
export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface AnthropicUsageLike {
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

/** Pulls token usage off an Anthropic message response (defaults to 0 when absent). */
export const extractUsage = (response: AnthropicUsageLike, model: string): TokenUsage => ({
  model,
  inputTokens: response.usage?.input_tokens ?? 0,
  outputTokens: response.usage?.output_tokens ?? 0,
});

export interface RecordLlmUsageInput {
  db: Database;
  repo: string;
  jobType: "process_pr" | "process_release" | "process_push" | "ask";
  usage: TokenUsage | null | undefined;
}

/**
 * Persists one usage row. Best-effort: metering must NEVER fail a summary that was
 * already published — any error is swallowed (logged) so the job still completes.
 */
export const recordLlmUsage = async (input: RecordLlmUsageInput): Promise<void> => {
  if (!input.usage) {
    return;
  }
  try {
    await input.db.insert(llmUsageTable).values({
      repo: input.repo,
      jobType: input.jobType,
      model: input.usage.model,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`[usage] failed to record ${input.jobType} usage for ${input.repo}: ${message}`);
  }
};
