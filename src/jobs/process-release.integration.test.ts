import { beforeEach, describe, expect, it, vi } from "vitest";

const gatherMock = vi.hoisted(() =>
  vi.fn<typeof import("@/sources/github/gather-release-context.js").execute>(),
);

const resolveCompareMock = vi.hoisted(() =>
  vi.fn(async (inp: { webhookBeforeSha: string }) => inp.webhookBeforeSha.trim()),
);

vi.mock("@/sources/github/gather-release-context.js", () => ({
  execute: gatherMock,
}));

vi.mock("@/jobs/resolve-release-compare-before.js", () => ({
  execute: resolveCompareMock,
}));

import { execute } from "@/jobs/process-release.js";

const buildSelectChain = (limitResult: unknown) => {
  const limit = vi.fn(async () => limitResult);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({
    limit,
    orderBy,
  }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, limit, where, from, orderBy };
};

const releaseSelectRow = (limitResult: unknown) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn(() => ({
      limit: vi.fn().mockResolvedValue(limitResult),
      orderBy: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(limitResult),
      })),
    })),
  }),
});

describe("jobs/process-release integration", () => {
  beforeEach(() => {
    gatherMock.mockReset();
    resolveCompareMock.mockReset();
    resolveCompareMock.mockImplementation(async (inp: { webhookBeforeSha: string }) =>
      inp.webhookBeforeSha.trim(),
    );
  });

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
      releasesNotionDatabaseId: "rel-db",
      releaseCompareRootSha: null,
      expoAppConfigPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease, prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease, publishPush: vi.fn() },
    });
    await handler.execute({
      repo: "o/r",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });
    expect(resolveCompareMock).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledTimes(2);
    expect(summarizeRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        prContributions: [],
        standaloneCommitHints: [],
      }),
    );
    expect(publishRelease).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        marketingEraStartSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );
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
      .mockReturnValueOnce(releaseSelectRow([]))
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
      })
      .mockReturnValueOnce(releaseSelectRow([]));

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
      releasesNotionDatabaseId: "rel-db",
      releaseCompareRootSha: null,
      expoAppConfigPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease, prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease, publishPush: vi.fn() },
    });
    await handler.execute({
      repo: "acme/ios",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });

    expect(select).toHaveBeenCalledTimes(3);
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
      .mockReturnValueOnce(releaseSelectRow([]))
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
      })
      .mockReturnValueOnce(releaseSelectRow([]));

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
      releasesNotionDatabaseId: "rel-db",
      releaseCompareRootSha: null,
      expoAppConfigPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease, prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease, publishPush: vi.fn() },
    }).execute({
      repo: "o/r",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });

    expect(select).toHaveBeenCalledTimes(3);
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
    const limit = vi.fn().mockResolvedValueOnce([{ id: "dup" }]);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ limit, orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
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
      releasesNotionDatabaseId: "rel-db",
      releaseCompareRootSha: null,
      expoAppConfigPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease, prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease, publishPush: vi.fn() },
    });
    await handler.execute({
      repo: "o/r",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });
    expect(resolveCompareMock).toHaveBeenCalledOnce();
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
      releasesNotionDatabaseId: "rel-db",
      releaseCompareRootSha: null,
      expoAppConfigPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease, prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease: vi.fn(), publishPush: vi.fn() },
    });
    await handler.execute({
      repo: "o/r",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });
    expect(resolveCompareMock).not.toHaveBeenCalled();
    expect(summarizeRelease).not.toHaveBeenCalled();
  });

  it("should call gather twice when compare base differs from webhook before", async () => {
    const webhookBefore = "a".repeat(40);
    const wideBefore = "c".repeat(40);
    const afterSha = "b".repeat(40);
    const wideContext = {
      beforeVersion: { short: "1", build: "1" },
      afterVersion: { short: "1", build: "2" },
      previousVersionKey: "1+1",
      newVersionKey: "1+2",
      compareCommits: [{ sha: "s2", message: "wide" }],
      commitMessages: ["wide"],
      prNumbers: [],
      totalCommits: 1,
      compareUrl: "https://wide",
      fileChangeSummary: "—",
    };
    gatherMock
      .mockResolvedValueOnce({
        beforeVersion: { short: "1", build: "1" },
        afterVersion: { short: "1", build: "2" },
        previousVersionKey: "1+1",
        newVersionKey: "1+2",
        compareCommits: [],
        commitMessages: [],
        prNumbers: [],
        totalCommits: 0,
        compareUrl: "https://narrow",
        fileChangeSummary: "—",
      })
      .mockResolvedValueOnce(wideContext);
    resolveCompareMock.mockResolvedValueOnce(wideBefore);

    const select = vi
      .fn()
      .mockReturnValueOnce(releaseSelectRow([]))
      .mockReturnValueOnce(releaseSelectRow([]));
    const values = vi.fn();
    const insert = vi.fn(() => ({ values }));
    const db = { select, insert } as never;
    const summarizeRelease = vi.fn(async () => ({
      title: "Wide",
      changelog: "More.",
      sections: [],
    }));
    const publishRelease = vi.fn(async () => ({ pageId: "pw" }));

    await execute({
      db,
      appId: "1",
      privateKey: "k",
      infoPlistPath: "p",
      projectPbxprojPath: null,
      releasesNotionDatabaseId: "rel-db",
      releaseCompareRootSha: null,
      expoAppConfigPath: null,
      promptVersion: 1,
      releaseSummarizer: { summarizeRelease, prompt: "p" },
      destination: { publishPR: vi.fn(), publishRelease, publishPush: vi.fn() },
    }).execute({
      repo: "o/r",
      beforeSha: webhookBefore,
      afterSha,
      branch: "develop",
    });

    expect(gatherMock).toHaveBeenCalledTimes(2);
    expect(gatherMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        beforeSha: webhookBefore,
        afterSha,
        compareBeforeSha: wideBefore,
      }),
    );
    expect(summarizeRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        context: wideContext,
        standaloneCommitHints: [{ sha: "s2", messageLine: "wide" }],
      }),
    );
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeSha: wideBefore,
        marketingEraStartSha: wideBefore,
      }),
    );
  });
});
