import { readFile } from "node:fs/promises";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { execute as loadEnv } from "@/config/env.js";
import { extractUsage, type TokenUsage } from "@/llm/usage.js";
import type { PullRequestEvent } from "@/sources/source.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 900;
const MAX_RETRIES = 1;
const DEFAULT_PROMPT_PATH = new URL("./prompts/pr-summary.md", import.meta.url);

const prSummarySchema = z.object({
  title: z.string().min(1),
  summaryUserFacing: z.string().min(1),
  summaryTechnical: z.string().min(1),
  category: z.enum(["feature", "bugfix", "refactor", "chore", "other"]),
  area: z.string().min(1).nullable(),
});

export type PRSummary = z.infer<typeof prSummarySchema>;

interface AnthropicResponseContentText {
  type: "text";
  text: string;
}

interface AnthropicResponseContentOther {
  type: string;
}

type AnthropicResponseContent = AnthropicResponseContentText | AnthropicResponseContentOther;

interface AnthropicMessageResponse {
  content: AnthropicResponseContent[];
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

export interface AnthropicClientLike {
  messages: {
    create: (input: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: "user"; content: string }>;
    }) => Promise<AnthropicMessageResponse>;
  };
}

export interface SummarizePullRequestInput {
  pullRequest: PullRequestEvent;
}

export interface Summarizer {
  summarizePR: (input: SummarizePullRequestInput) => Promise<PRSummary & { usage: TokenUsage }>;
  prompt: string;
}

export interface ExecuteInput {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  promptPath?: URL;
  readPrompt?: (path: URL) => Promise<string>;
  anthropicClientFactory?: (apiKey: string) => AnthropicClientLike;
}

const extractTextFromResponse = (response: AnthropicMessageResponse): string => {
  const text = response.content
    .filter((item): item is AnthropicResponseContentText => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("LLM response did not contain text content.");
  }

  return text;
};

const extractJsonObject = (text: string): string => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("LLM response did not contain a JSON object.");
  }

  return text.slice(start, end + 1);
};

const parseSummary = (text: string): PRSummary => {
  const jsonCandidate = extractJsonObject(text);
  const parsed = JSON.parse(jsonCandidate) as unknown;
  return prSummarySchema.parse(parsed);
};

const buildUserMessage = (pullRequest: PullRequestEvent): string => {
  return JSON.stringify(
    {
      repo: pullRequest.repo,
      prNumber: pullRequest.prNumber,
      title: pullRequest.title,
      body: pullRequest.body,
      author: pullRequest.author,
      mergedAt: pullRequest.mergedAt.toISOString(),
      headSha: pullRequest.headSha,
      baseBranch: pullRequest.baseBranch,
      files: pullRequest.files,
      diff: pullRequest.diff,
    },
    null,
    2,
  );
};

const getApiKey = (input: ExecuteInput): string => {
  if (input.apiKey) {
    return input.apiKey;
  }

  return loadEnv().ANTHROPIC_API_KEY;
};

const getAnthropicClientFactory = (
  factory?: ExecuteInput["anthropicClientFactory"],
): ((apiKey: string) => AnthropicClientLike) => {
  if (factory) {
    return factory;
  }

  return (apiKey) => new Anthropic({ apiKey });
};

const getPromptReader = (
  reader?: ExecuteInput["readPrompt"],
): ((path: URL) => Promise<string>) => {
  if (reader) {
    return reader;
  }

  return async (path) => readFile(path, "utf8");
};

export const execute = async (input: ExecuteInput = {}): Promise<Summarizer> => {
  const model = input.model ?? DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const promptPath = input.promptPath ?? DEFAULT_PROMPT_PATH;
  const prompt = await getPromptReader(input.readPrompt)(promptPath);
  const anthropic = getAnthropicClientFactory(input.anthropicClientFactory)(
    getApiKey(input),
  );

  return {
    prompt,
    summarizePR: async ({ pullRequest }) => {
      const userMessage = buildUserMessage(pullRequest);

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        const response = await anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          system: prompt,
          messages: [{ role: "user", content: userMessage }],
        });

        try {
          const parsed = parseSummary(extractTextFromResponse(response));
          return { ...parsed, usage: extractUsage(response, model) };
        } catch (error) {
          if (attempt === MAX_RETRIES) {
            throw new Error("Failed to parse LLM summary response.", { cause: error });
          }
        }
      }

      throw new Error("Unexpected summarizer state.");
    },
  };
};
