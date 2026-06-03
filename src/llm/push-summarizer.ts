import { readFile } from "node:fs/promises";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { execute as loadEnv } from "@/config/env.js";
import { extractUsage, type TokenUsage } from "@/llm/usage.js";
import type { PushContext } from "@/sources/github/gather-push-context.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 900;
const MAX_RETRIES = 1;
const DEFAULT_PROMPT_PATH = new URL("./prompts/push-summary.md", import.meta.url);
const MAX_COMMIT_LINES = 120;
const MAX_LINE_CHARS = 240;

const pushSummarySchema = z.object({
  title: z.string().min(1),
  summaryUserFacing: z.string().min(1),
  summaryTechnical: z.string().min(1),
  category: z.enum(["feature", "bugfix", "refactor", "chore", "other"]),
  area: z.string().min(1).nullable(),
});

export type PushSummaryResult = z.infer<typeof pushSummarySchema>;

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

export interface SummarizePushInput {
  context: PushContext;
  repo: string;
  branch: string;
}

export interface PushSummarizer {
  summarizePush: (input: SummarizePushInput) => Promise<PushSummaryResult & { usage: TokenUsage }>;
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

const parseSummary = (text: string): PushSummaryResult => {
  const jsonCandidate = extractJsonObject(text);
  const parsed = JSON.parse(jsonCandidate) as unknown;
  return pushSummarySchema.parse(parsed);
};

const buildCommitLines = (context: PushContext): string[] => {
  return context.compareCommits.slice(0, MAX_COMMIT_LINES).map((commit) => {
    const first = commit.message.split("\n")[0]?.trim() ?? "";
    const line = `${commit.sha.slice(0, 7)} ${first}`;
    return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
  });
};

const buildUserMessage = (input: SummarizePushInput): string => {
  const { context } = input;
  return JSON.stringify(
    {
      repo: input.repo,
      branch: input.branch,
      totalCommits: context.totalCommits,
      prNumbers: context.prNumbers,
      compareUrl: context.compareUrl,
      fileChangeSummary: context.fileChangeSummary,
      commits: buildCommitLines(context),
      diff: context.diff,
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

export const execute = async (input: ExecuteInput = {}): Promise<PushSummarizer> => {
  const model = input.model ?? DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const promptPath = input.promptPath ?? DEFAULT_PROMPT_PATH;
  const prompt = await getPromptReader(input.readPrompt)(promptPath);
  const anthropic = getAnthropicClientFactory(input.anthropicClientFactory)(getApiKey(input));

  return {
    prompt,
    summarizePush: async (summarizeInput) => {
      const userMessage = buildUserMessage(summarizeInput);

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
            throw new Error("Failed to parse LLM push summary response.", { cause: error });
          }
        }
      }

      throw new Error("Unexpected push summarizer state.");
    },
  };
};
