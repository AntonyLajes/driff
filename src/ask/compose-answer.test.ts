import { describe, expect, it, vi } from "vitest";

import {
  execute,
  type AnthropicClientLike,
  type ComposeAnswerInput,
} from "@/ask/compose-answer.js";

const retrieval = {
  status: "no_evidence",
  mode: "change",
  confidence: "none",
  queryTerms: ["checkout"],
  period: null,
  totalMatches: 0,
  hasMore: false,
  version: null,
  matches: [],
} satisfies ComposeAnswerInput["retrieval"];

describe("ask/compose-answer execute", () => {
  it("should compose a natural answer from retrieval and conversation context", async () => {
    const create = vi.fn<AnthropicClientLike["messages"]["create"]>(async () => ({
      content: [
        {
          type: "text" as const,
          text: "Não encontrei essa alteração no histórico disponível.",
        },
      ],
      usage: { input_tokens: 320, output_tokens: 42 },
    }));
    const composer = await execute({
      apiKey: "anthropic-key",
      model: "test-model",
      readPrompt: async () => "Use only supplied evidence.",
      anthropicClientFactory: () => ({ messages: { create } }),
    });

    const result = await composer.compose({
      question: "O checkout mudou?",
      conversation: [
        { role: "user", content: "O que mudou recentemente?" },
        { role: "assistant", content: "A Home recebeu melhorias." },
      ],
      retrieval,
    });

    expect(result).toEqual({
      answerText: "Não encontrei essa alteração no histórico disponível.",
      usage: { model: "test-model", inputTokens: 320, outputTokens: 42 },
    });
    const request = create.mock.calls[0]?.[0];
    expect(request?.system).toBe("Use only supplied evidence.");
    expect(request?.messages[0]?.content).toContain("O checkout mudou?");
    expect(request?.messages[0]?.content).toContain("A Home recebeu melhorias.");
    expect(request?.messages[0]?.content).toContain('"status": "no_evidence"');
  });

  it("should fail when the model returns no text", async () => {
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(async () => ({ content: [{ type: "tool_use" }] })),
      },
    };
    const composer = await execute({
      apiKey: "anthropic-key",
      readPrompt: async () => "prompt",
      anthropicClientFactory: () => client,
    });

    await expect(
      composer.compose({
        question: "O checkout mudou?",
        conversation: [],
        retrieval,
      }),
    ).rejects.toThrow("did not contain text content");
  });
});
