import { readFile } from "node:fs/promises";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { execute as loadEnv } from "@/config/env.js";
import type { ReleaseContext } from "@/sources/github/gather-release-context.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4_096;
const MAX_RETRIES = 1;
const DEFAULT_PROMPT_PATH = new URL("./prompts/release-changelog.md", import.meta.url);
const MAX_COMMIT_MESSAGES = 120;
const MAX_MSG_CHARS = 800;

const releaseChangelogSchema = z.object({
  title: z.string().min(1),
  changelog: z.string().min(1),
  sections: z.array(
    z.object({
      label: z.string().min(1),
      items: z.array(z.string().min(1)),
    }),
  ),
});

export type ReleaseChangelogNotes = z.infer<typeof releaseChangelogSchema>;

interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
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

export interface PrContributionForRelease {
  prNumber: number;
  summaryUserFacing: string | null;
  category: string | null;
  title: string | null;
}

export interface SummarizeReleaseInput {
  context: ReleaseContext;
  repo: string;
  branch: string;
  prContributions: PrContributionForRelease[];
  standaloneCommitHints: Array<{ sha: string; messageLine: string }>;
}

const extractTextFromResponse = (response: AnthropicMessageResponse): string => {
  const text = response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && Boolean(item.text))
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

const parseReleaseChangelogNotes = (text: string): ReleaseChangelogNotes => {
  const jsonCandidate = extractJsonObject(text);
  const parsed = JSON.parse(jsonCandidate) as unknown;
  return releaseChangelogSchema.parse(parsed);
};

const trimCommitMessages = (messages: string[]): string[] => {
  return messages
    .slice(0, MAX_COMMIT_MESSAGES)
    .map((m) => (m.length > MAX_MSG_CHARS ? `${m.slice(0, MAX_MSG_CHARS)}…` : m));
};

const buildUserMessage = (input: SummarizeReleaseInput): string => {
  const { context } = input;
  return JSON.stringify(
    {
      repo: input.repo,
      branch: input.branch,
      previousVersionKey: context.previousVersionKey,
      newVersionKey: context.newVersionKey,
      shortVersion: context.afterVersion.short,
      buildVersion: context.afterVersion.build,
      prNumbers: context.prNumbers,
      totalCommits: context.totalCommits,
      compareUrl: context.compareUrl,
      fileChangeSummary: context.fileChangeSummary,
      prContributions: input.prContributions,
      standaloneCommitHints: input.standaloneCommitHints,
      commitMessagesFallback: trimCommitMessages(context.commitMessages),
    },
    null,
    2,
  );
};

export interface ReleaseSummarizer {
  summarizeRelease: (input: SummarizeReleaseInput) => Promise<ReleaseChangelogNotes>;
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
  return (apiKey) => new Anthropic({ apiKey }) as unknown as AnthropicClientLike;
};

const getPromptReader = (reader?: ExecuteInput["readPrompt"]): ((path: URL) => Promise<string>) => {
  if (reader) {
    return reader;
  }
  return async (path) => readFile(path, "utf8");
};

export const execute = async (input: ExecuteInput = {}): Promise<ReleaseSummarizer> => {
  const model = input.model ?? DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const promptPath = input.promptPath ?? DEFAULT_PROMPT_PATH;
  const prompt = await getPromptReader(input.readPrompt)(promptPath);
  const anthropic = getAnthropicClientFactory(input.anthropicClientFactory)(getApiKey(input));

  return {
    prompt,
    summarizeRelease: async (summarizeInput) => {
      const userMessage = buildUserMessage(summarizeInput);

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        const response = await anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          system: prompt,
          messages: [{ role: "user", content: userMessage }],
        });

        try {
          return parseReleaseChangelogNotes(extractTextFromResponse(response));
        } catch (error) {
          if (attempt === MAX_RETRIES) {
            throw new Error("Failed to parse LLM release changelog response.", { cause: error });
          }
        }
      }

      throw new Error("Unexpected release summarizer state.");
    },
  };
};
