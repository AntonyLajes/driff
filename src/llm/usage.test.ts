import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client.js";
import { extractUsage, recordLlmUsage } from "@/llm/usage.js";

describe("llm/usage extractUsage", () => {
  it("maps Anthropic usage to TokenUsage", () => {
    const usage = extractUsage({ usage: { input_tokens: 1200, output_tokens: 300 } }, "model-x");
    expect(usage).toEqual({ model: "model-x", inputTokens: 1200, outputTokens: 300 });
  });

  it("defaults to zero when usage is absent", () => {
    expect(extractUsage({}, "model-x")).toEqual({
      model: "model-x",
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("llm/usage recordLlmUsage", () => {
  const buildDb = () => {
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    return { db: { insert } as unknown as Database, insert, values };
  };

  it("inserts a row when usage is present", async () => {
    const { db, insert, values } = buildDb();
    await recordLlmUsage({
      db,
      repo: "acme/app",
      jobType: "process_pr",
      usage: { model: "m", inputTokens: 10, outputTokens: 5 },
    });
    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "acme/app",
        jobType: "process_pr",
        model: "m",
        inputTokens: 10,
        outputTokens: 5,
      }),
    );
  });

  it("is a no-op when usage is missing", async () => {
    const { db, insert } = buildDb();
    await recordLlmUsage({ db, repo: "acme/app", jobType: "process_push", usage: null });
    expect(insert).not.toHaveBeenCalled();
  });

  it("never throws when the insert fails (metering must not break the job)", async () => {
    const values = vi.fn(async () => {
      throw new Error("db down");
    });
    const db = { insert: vi.fn(() => ({ values })) } as unknown as Database;
    await expect(
      recordLlmUsage({
        db,
        repo: "acme/app",
        jobType: "process_release",
        usage: { model: "m", inputTokens: 1, outputTokens: 1 },
      }),
    ).resolves.toBeUndefined();
  });
});
