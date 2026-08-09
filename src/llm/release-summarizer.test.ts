import { describe, expect, it, vi } from "vitest";

import { execute } from "@/llm/release-summarizer.js";
import type { ReleaseContext } from "@/sources/github/gather-release-context.js";

const baseContext: ReleaseContext = {
  beforeVersion: { short: "1.0.0", build: "1" },
  afterVersion: { short: "1.0.1", build: "2" },
  previousVersionKey: "1.0.0+1",
  newVersionKey: "1.0.1+2",
  compareCommits: [{ sha: "abc", message: "Merge pull request #3 from o/f" }],
  commitMessages: ["Merge pull request #3 from o/f"],
  prNumbers: [3],
  totalCommits: 1,
  compareUrl: "https://github.com/o/r/compare/1.0.0...1.0.1",
  fileChangeSummary: "M: a.swift",
};

const baseSummarizeInput = {
  context: baseContext,
  repo: "o/r",
  branch: "develop",
  prContributions: [
    { prNumber: 3, summaryUserFacing: "Fixed login spinner.", category: "bugfix", title: "fix login" },
  ],
  standaloneCommitHints: [{ sha: "z", messageLine: "chore: plist" }],
};

describe("llm/release-summarizer execute", () => {
  it("should return parsed release changelog from model response", async () => {
    const json =
      '{"title":"1.0.1 (2)","changelog":"Bug fixes for login.","sections":[{"label":"Fixed","items":["#3 spinner"]}]}';
    const create = vi.fn(async () => ({
      content: [{ type: "text" as const, text: json }],
    }));
    const summarizer = await execute({
      apiKey: "test-key",
      readPrompt: async () => "You are a changelog writer.",
      anthropicClientFactory: () => ({
        messages: { create },
      }),
    });
    const result = await summarizer.summarizeRelease({
      ...baseSummarizeInput,
      language: "pt-BR",
    });
    expect(result.title).toBe("1.0.1 (2)");
    expect(result.changelog).toContain("Bug fixes");
    expect(result.sections[0]?.label).toBe("Fixed");
    expect(create).toHaveBeenCalledOnce();
    const calls = create.mock.calls as unknown as Array<
      [{ messages: Array<{ content: string }> }]
    >;
    expect(calls[0]?.[0]?.messages[0]?.content).toContain(
      '"outputLanguage": "pt-BR"',
    );
  });

  it("should retry once when first response is not valid JSON", async () => {
    const badThenGood = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "text" as const, text: "not json" }] })
      .mockResolvedValueOnce({
        content: [
          {
            type: "text" as const,
            text: '{"title":"ok","changelog":"c","sections":[]}',
          },
        ],
      });
    const summarizer = await execute({
      apiKey: "k",
      readPrompt: async () => "sys",
      anthropicClientFactory: () => ({
        messages: { create: badThenGood },
      }),
    });
    const result = await summarizer.summarizeRelease(baseSummarizeInput);
    expect(result.title).toBe("ok");
    expect(badThenGood).toHaveBeenCalledTimes(2);
  });
});
