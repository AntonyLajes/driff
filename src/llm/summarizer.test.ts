import { describe, expect, it, vi } from "vitest";

import { execute } from "@/llm/summarizer.js";
import type { AnthropicClientLike } from "@/llm/summarizer.js";
import type { PullRequestEvent } from "@/sources/source.js";

const buildPullRequest = (): PullRequestEvent => ({
  repo: "acme/mobile-app",
  prNumber: 42,
  title: "feat: add payments flow",
  body: "Implements the new checkout experience.",
  author: "octocat",
  mergedAt: new Date("2026-04-25T18:30:00Z"),
  headSha: "abc123",
  baseBranch: "main",
  files: [{ path: "src/payments.ts", additions: 20, deletions: 3 }],
  diff: "diff --git a/src/payments.ts b/src/payments.ts",
});

type CreateMessageFn = AnthropicClientLike["messages"]["create"];

const buildAnthropicClient = (createImpl: CreateMessageFn) => {
  const create = vi.fn<CreateMessageFn>(createImpl);
  const client: AnthropicClientLike = {
    messages: { create },
  };

  return { client, create };
};

describe("llm/summarizer execute", () => {
  it("should parse valid JSON response", async () => {
    const anthropic = buildAnthropicClient(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Add payment flow",
            summaryUserFacing: "Users can now pay with fewer steps.",
            summaryTechnical: "Introduces checkout service and wiring.",
            category: "feature",
            area: "checkout",
          }),
        },
      ],
    }));
    const summarizer = await execute({
      apiKey: "anthropic-key",
      readPrompt: async () => "prompt",
      anthropicClientFactory: () => anthropic.client,
    });

    const summary = await summarizer.summarizePR({
      pullRequest: buildPullRequest(),
    });

    expect(summary).toEqual({
      title: "Add payment flow",
      summaryUserFacing: "Users can now pay with fewer steps.",
      summaryTechnical: "Introduces checkout service and wiring.",
      category: "feature",
      area: "checkout",
    });
    expect(anthropic.create).toHaveBeenCalledOnce();
  });

  it("should retry once when first response is invalid json", async () => {
    let callCount = 0;
    const anthropic = buildAnthropicClient(
      async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: [{ type: "text", text: "not-json" }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                title: "Fix crash",
                summaryUserFacing: "No direct user-facing impact.",
                summaryTechnical: "Fixes null dereference in checkout.",
                category: "bugfix",
                area: null,
              }),
            },
          ],
        };
      },
    );
    const summarizer = await execute({
      apiKey: "anthropic-key",
      readPrompt: async () => "prompt",
      anthropicClientFactory: () => anthropic.client,
    });

    const summary = await summarizer.summarizePR({
      pullRequest: buildPullRequest(),
    });

    expect(summary.category).toBe("bugfix");
    expect(anthropic.create).toHaveBeenCalledTimes(2);
  });

  it("should throw when response remains invalid after retry", async () => {
    const anthropic = buildAnthropicClient(async () => ({
      content: [{ type: "text", text: "invalid" }],
    }));
    const summarizer = await execute({
      apiKey: "anthropic-key",
      readPrompt: async () => "prompt",
      anthropicClientFactory: () => anthropic.client,
    });

    await expect(
      summarizer.summarizePR({
        pullRequest: buildPullRequest(),
      }),
    ).rejects.toThrowError(/Failed to parse LLM summary response/);
    expect(anthropic.create).toHaveBeenCalledTimes(2);
  });

  it("should expose loaded prompt content", async () => {
    const anthropic = buildAnthropicClient(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Refactor payments",
            summaryUserFacing: "No direct user-facing impact.",
            summaryTechnical: "Moves logic into dedicated modules.",
            category: "refactor",
            area: "payments",
          }),
        },
      ],
    }));
    const summarizer = await execute({
      apiKey: "anthropic-key",
      readPrompt: async () => "my prompt",
      anthropicClientFactory: () => anthropic.client,
    });

    expect(summarizer.prompt).toBe("my prompt");
  });

  it("should read prompt from filesystem when readPrompt is not provided", async () => {
    const anthropic = buildAnthropicClient(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Chore updates",
            summaryUserFacing: "No direct user-facing impact.",
            summaryTechnical: "Updates internal prompt loading path.",
            category: "chore",
            area: null,
          }),
        },
      ],
    }));
    const summarizer = await execute({
      apiKey: "anthropic-key",
      promptPath: new URL("./prompts/pr-summary.md", import.meta.url),
      anthropicClientFactory: () => anthropic.client,
    });

    expect(summarizer.prompt).toContain("You are an assistant");
  });

  it("should create default anthropic client when no factory is provided", async () => {
    const summarizer = await execute({
      apiKey: "anthropic-key",
      readPrompt: async () => "prompt",
    });

    expect(summarizer.prompt).toBe("prompt");
  });
});
