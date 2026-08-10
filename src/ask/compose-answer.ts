import { readFile } from "node:fs/promises";

import Anthropic from "@anthropic-ai/sdk";

import type { execute as searchHistory } from "@/ask/search-history.js";
import { execute as loadEnv } from "@/config/env.js";
import { extractUsage, type TokenUsage } from "@/llm/usage.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 700;
const DEFAULT_PROMPT_PATH = new URL(
  "../llm/prompts/ask-answer.md",
  import.meta.url,
);

type SearchResult = Awaited<ReturnType<typeof searchHistory>>;

export type AskConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

interface AnthropicResponseContentText {
  type: "text";
  text: string;
}

interface AnthropicResponseContentOther {
  type: string;
}

interface AnthropicMessageResponse {
  content: Array<
    AnthropicResponseContentText | AnthropicResponseContentOther
  >;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

interface AnthropicMessageStreamLike {
  on: (
    event: "text",
    listener: (textDelta: string, textSnapshot: string) => void,
  ) => AnthropicMessageStreamLike;
  finalMessage: () => Promise<AnthropicMessageResponse>;
  abort: () => void;
}

export interface AnthropicClientLike {
  messages: {
    create: (input: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: "user"; content: string }>;
    }) => Promise<AnthropicMessageResponse>;
    stream?: (input: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: "user"; content: string }>;
    }) => AnthropicMessageStreamLike;
  };
}

export interface ComposeAnswerInput {
  question: string;
  conversation: AskConversationTurn[];
  retrieval: SearchResult;
}

export interface ComposedAnswer {
  answerText: string;
  usage: TokenUsage;
}

export interface AskAnswerComposer {
  compose: (input: ComposeAnswerInput) => Promise<ComposedAnswer>;
  stream: (
    input: ComposeAnswerInput & {
      onText: (textDelta: string) => void;
      signal?: AbortSignal;
    },
  ) => Promise<ComposedAnswer>;
}

export interface ExecuteInput {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  promptPath?: URL;
  readPrompt?: (path: URL) => Promise<string>;
  anthropicClientFactory?: (apiKey: string) => AnthropicClientLike;
}

const extractText = (response: AnthropicMessageResponse): string => {
  const text = response.content
    .filter((item): item is AnthropicResponseContentText => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (text.length === 0) {
    throw new Error("Ask answer response did not contain text content.");
  }
  return text;
};

const buildRetrievalContext = (retrieval: SearchResult) => ({
  status: retrieval.status,
  confidence: retrieval.confidence,
  period: retrieval.period,
  version: retrieval.version,
  totalMatches: retrieval.totalMatches,
  matches: retrieval.matches.map(({ change, version }) => ({
    title: change.title,
    summaryExecutive: change.summaryExecutive,
    summaryTechnical: change.summaryTechnical,
    category: change.category,
    firstOccurredAt: change.firstOccurredAt,
    lastOccurredAt: change.lastOccurredAt,
    areas: change.areas.map((area) => area.name),
    contributors: change.contributors.map((contributor) => ({
      name: contributor.displayName ?? contributor.externalIdentity,
      role: contributor.role,
      isBot: contributor.isBot,
    })),
    version:
      version === null
        ? null
        : {
            displayVersion: version.displayVersion,
            buildVersion: version.buildVersion,
            releasedAt: version.releasedAt,
          },
    evidence: change.evidence.map((evidence) => ({
      kind: evidence.kind,
      externalId: evidence.externalId,
      occurredAt: evidence.occurredAt,
    })),
  })),
});

const buildMessage = ({
  question,
  conversation,
  retrieval,
}: ComposeAnswerInput): string =>
  JSON.stringify(
    {
      question,
      conversation: conversation.slice(-8),
      retrieval: buildRetrievalContext(retrieval),
    },
    null,
    2,
  );

export const execute = async (
  input: ExecuteInput = {},
): Promise<AskAnswerComposer> => {
  const model = input.model ?? DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const promptPath = input.promptPath ?? DEFAULT_PROMPT_PATH;
  const prompt = await (input.readPrompt ?? ((path) => readFile(path, "utf8")))(
    promptPath,
  );
  const apiKey = input.apiKey ?? loadEnv().ANTHROPIC_API_KEY;
  const anthropic = (input.anthropicClientFactory ??
    ((key) => new Anthropic({ apiKey: key })))(apiKey);

  return {
    compose: async ({ question, conversation, retrieval }) => {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system: prompt,
        messages: [
          {
            role: "user",
            content: buildMessage({ question, conversation, retrieval }),
          },
        ],
      });
      return {
        answerText: extractText(response),
        usage: extractUsage(response, model),
      };
    },
    stream: async ({
      question,
      conversation,
      retrieval,
      onText,
      signal,
    }) => {
      if (anthropic.messages.stream === undefined) {
        return (async () => {
          const composed = await anthropic.messages.create({
            model,
            max_tokens: maxTokens,
            system: prompt,
            messages: [
              {
                role: "user",
                content: buildMessage({ question, conversation, retrieval }),
              },
            ],
          });
          const answerText = extractText(composed);
          onText(answerText);
          return { answerText, usage: extractUsage(composed, model) };
        })();
      }

      const stream = anthropic.messages.stream({
        model,
        max_tokens: maxTokens,
        system: prompt,
        messages: [
          {
            role: "user",
            content: buildMessage({ question, conversation, retrieval }),
          },
        ],
      });
      const abort = () => stream.abort();
      if (signal?.aborted === true) abort();
      signal?.addEventListener("abort", abort, { once: true });
      stream.on("text", (textDelta) => {
        if (textDelta.length > 0) onText(textDelta);
      });
      try {
        const response = await stream.finalMessage();
        return {
          answerText: extractText(response),
          usage: extractUsage(response, model),
        };
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
};
