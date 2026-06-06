import { describe, expect, it, vi } from "vitest";

import { execute } from "@/llm/push-summarizer.js";
import type { PushContext } from "@/sources/github/gather-push-context.js";

const context: PushContext = {
  compareCommits: [{ sha: "b".repeat(40), message: "fix: guard null session" }],
  commitMessages: ["fix: guard null session"],
  prNumbers: [],
  totalCommits: 1,
  compareUrl: "https://github.com/acme/app/compare/aaa...bbb",
  fileChangeSummary: "modified: src/login.ts",
  additions: null,
  deletions: null,
  changedFiles: null,
  diff: "diff --git a/src/login.ts b/src/login.ts",
};

describe("llm/push-summarizer", () => {
  it("parses a JSON summary from the model response", async () => {
    const create = vi.fn(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Hotfix login crash",
            summaryUserFacing: "Fixes a crash on login.",
            summaryTechnical: "Guards a null session before access.",
            category: "bugfix",
            area: "login",
          }),
        },
      ],
    }));

    const summarizer = await execute({
      apiKey: "test",
      readPrompt: async () => "system prompt",
      anthropicClientFactory: () => ({ messages: { create } }),
    });

    const result = await summarizer.summarizePush({ context, repo: "acme/app", branch: "main" });

    expect(result.category).toBe("bugfix");
    expect(result.title).toBe("Hotfix login crash");
    expect(create).toHaveBeenCalledOnce();
    const calls = create.mock.calls as unknown as Array<[{ messages: Array<{ content: string }> }]>;
    expect(calls[0]?.[0]?.messages[0]?.content).toContain("acme/app");
  });

  it("throws after retries when the response has no JSON object", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: "no json here" }] }));
    const summarizer = await execute({
      apiKey: "test",
      readPrompt: async () => "system prompt",
      anthropicClientFactory: () => ({ messages: { create } }),
    });

    await expect(
      summarizer.summarizePush({ context, repo: "acme/app", branch: "main" }),
    ).rejects.toThrow(/Failed to parse LLM push summary response/);
  });
});
