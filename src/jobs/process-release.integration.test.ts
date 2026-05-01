import { describe, expect, it, vi } from "vitest";

const gatherMock = vi.hoisted(() =>
  vi.fn<typeof import("@/sources/github/gather-release-context.js").execute>(),
);

vi.mock("@/config/env.js", () => ({
  execute: () => ({
    NOTION_RELEASES_DATABASE_ID: "rel-db",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
  }),
}));

vi.mock("@/sources/github/gather-release-context.js", () => ({
  execute: gatherMock,
}));

import { execute } from "@/jobs/process-release.js";

const buildSelectChain = (limitResult: unknown) => {
  const limit = vi.fn(async () => limitResult);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, limit, where, from };
};

describe("jobs/process-release integration", () => {
  it("should publish and insert when no duplicate release exists", async () => {
    gatherMock.mockResolvedValue({
      beforeVersion: { short: "1", build: "1" },
      afterVersion: { short: "1", build: "2" },
      previousVersionKey: "1+1",
      newVersionKey: "1+2",
      compareCommits: [],
      commitMessages: [],
      prNumbers: [],
      totalCommits: 0,
      compareUrl: "https://c",
      fileChangeSummary: "—",
    });
    const { select } = buildSelectChain([]);
    const values = vi.fn();
    const insert = vi.fn(() => ({ values }));
    const db = { select, insert } as never;
    const publishRelease = vi.fn(async () => ({ pageId: "p1" }));
    const summarizeRelease = vi.fn(async () => ({
      title: "R",
      changelog: "What's new.",
      sections: [],
    }));
    const handler = execute({
      db,
      appId: "1",
      privateKey: "k",
      infoPlistPath: "p",
      projectPbxprojPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease, prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease },
    });
    await handler.execute({
      repo: "o/r",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(summarizeRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        prContributions: [],
        standaloneCommitHints: [],
      }),
    );
    expect(publishRelease).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledOnce();
  });

  it("should pass PR rows and standalone hints to release summarizer", async () => {
    gatherMock.mockResolvedValue({
      beforeVersion: { short: "1", build: "1" },
      afterVersion: { short: "1", build: "2" },
      previousVersionKey: "1+1",
      newVersionKey: "1+2",
      compareCommits: [
        { sha: "dead", message: "fix typo in label" },
        { sha: "beef", message: "Merge pull request #9 from org/feat" },
      ],
      commitMessages: ["fix typo in label", "Merge pull request #9 from org/feat"],
      prNumbers: [9],
      totalCommits: 2,
      compareUrl: "https://c",
      fileChangeSummary: "—",
    });
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              prNumber: 9,
              summaryUserFacing: "Brighter welcome screen.",
              category: "feature",
              title: "Welcome tweaks",
            },
          ]),
        }),
      });

    const values = vi.fn();
    const insert = vi.fn(() => ({ values }));
    const publishRelease = vi.fn(async () => ({ pageId: "p99" }));
    const summarizeRelease = vi.fn(async () => ({
      title: "Rel",
      changelog: "Stuff.",
      sections: [],
    }));
    const db = { select, insert } as never;

    const handler = execute({
      db,
      appId: "1",
      privateKey: "k",
      infoPlistPath: "p",
      projectPbxprojPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease, prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease },
    });
    await handler.execute({
      repo: "acme/ios",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });

    expect(summarizeRelease).toHaveBeenCalledWith({
      repo: "acme/ios",
      branch: "develop",
      context: expect.any(Object),
      prContributions: [
        {
          prNumber: 9,
          summaryUserFacing: "Brighter welcome screen.",
          category: "feature",
          title: "Welcome tweaks",
        },
      ],
      standaloneCommitHints: [{ sha: "dead", messageLine: "fix typo in label" }],
    });
  });

  it("should dedupe duplicate PR numbers in the compare range", async () => {
    gatherMock.mockResolvedValue({
      beforeVersion: { short: "1", build: "1" },
      afterVersion: { short: "1", build: "2" },
      previousVersionKey: "1+1",
      newVersionKey: "1+2",
      compareCommits: [{ sha: "s1", message: "Merge pull request #9 from a/x" }],
      commitMessages: ["Merge pull request #9 from a/x"],
      prNumbers: [9, 9],
      totalCommits: 1,
      compareUrl: "https://c",
      fileChangeSummary: "—",
    });
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              prNumber: 9,
              summaryUserFacing: "One entry only.",
              category: "feature",
              title: "Nine",
            },
          ]),
        }),
      });

    const insert = vi.fn(() => ({ values: vi.fn() }));
    const publishRelease = vi.fn(async () => ({ pageId: "pd" }));
    const summarizeRelease = vi.fn(async () => ({
      title: "T",
      changelog: "c",
      sections: [],
    }));
    const db = { select, insert } as never;

    await execute({
      db,
      appId: "1",
      privateKey: "k",
      infoPlistPath: "p",
      projectPbxprojPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease, prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease },
    }).execute({
      repo: "o/r",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });

    expect(summarizeRelease).toHaveBeenCalledWith({
      repo: "o/r",
      branch: "develop",
      context: expect.objectContaining({
        prNumbers: [9],
      }),
      prContributions: [
        {
          prNumber: 9,
          summaryUserFacing: "One entry only.",
          category: "feature",
          title: "Nine",
        },
      ],
      standaloneCommitHints: [],
    });
    expect(publishRelease).toHaveBeenCalledWith(expect.objectContaining({ prNumbers: [9] }));
  });

  it("should skip LLM when release version already stored", async () => {
    gatherMock.mockResolvedValue({
      beforeVersion: { short: "1", build: "1" },
      afterVersion: { short: "1", build: "2" },
      previousVersionKey: "1+1",
      newVersionKey: "1+2",
      compareCommits: [],
      commitMessages: [],
      prNumbers: [],
      totalCommits: 0,
      compareUrl: "https://c",
      fileChangeSummary: "—",
    });
    const { select } = buildSelectChain([{ id: "dup" }]);
    const insert = vi.fn();
    const db = { select, insert } as never;
    const summarizeRelease = vi.fn();
    const publishRelease = vi.fn();
    const handler = execute({
      db,
      appId: "1",
      privateKey: "k",
      infoPlistPath: "p",
      projectPbxprojPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease, prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease },
    });
    await handler.execute({
      repo: "o/r",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });
    expect(summarizeRelease).not.toHaveBeenCalled();
    expect(publishRelease).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("should skip when version key unchanged", async () => {
    gatherMock.mockResolvedValue({
      beforeVersion: { short: "1", build: "1" },
      afterVersion: { short: "1", build: "1" },
      previousVersionKey: "1+1",
      newVersionKey: "1+1",
      compareCommits: [],
      commitMessages: [],
      prNumbers: [],
      totalCommits: 0,
      compareUrl: "https://c",
      fileChangeSummary: "—",
    });
    const summarizeRelease = vi.fn();
    const handler = execute({
      db: { select: vi.fn(), insert: vi.fn() } as never,
      appId: "1",
      privateKey: "k",
      infoPlistPath: "p",
      projectPbxprojPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease, prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease: vi.fn() },
    });
    await handler.execute({
      repo: "o/r",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });
    expect(summarizeRelease).not.toHaveBeenCalled();
  });
});
