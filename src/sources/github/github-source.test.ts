import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { execute, type OctokitLike } from "@/sources/github/github-source.js";

const buildPrivateKey = (): string => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  return privateKey.export({ format: "pem", type: "pkcs1" }).toString();
};

const buildAppOctokitMock = (
  installationId: number,
  token: string,
): OctokitLike => {
  const request: OctokitLike["request"] = async <TData>(route: string) => {
    if (route === "GET /repos/{owner}/{repo}/installation") {
      return { data: { id: installationId } as TData };
    }

    return { data: { token } as TData };
  };

  return {
    request,
    pulls: {
      get: vi.fn(),
      listFiles: vi.fn(),
    },
  };
};

const buildInstallationOctokitMock = (
  options: {
    mergedAt?: string | null;
    listFilesPages?: Array<
      Array<{ filename: string; additions: number; deletions: number }>
    >;
    diff?: string;
    commits?: Array<{
      author: { login: string; type?: string } | null;
      commit: {
        author: { name: string | null } | null;
        message: string;
      };
    }>;
    reviews?: Array<{
      user: { login: string; type?: string } | null;
      state: string;
    }>;
    mergedBy?: { login: string; type?: string } | null;
  } = {},
): OctokitLike => {
  const mergedAt =
    options.mergedAt === undefined ? "2026-04-25T18:00:00Z" : options.mergedAt;
  const listFilesPages = options.listFilesPages ?? [
    [{ filename: "src/index.ts", additions: 10, deletions: 2 }],
  ];
  const diff = options.diff ?? "diff --git a/src/index.ts b/src/index.ts";
  const commits = options.commits ?? [];
  const reviews = options.reviews ?? [];

  const request: OctokitLike["request"] = async <TData>(route: string) => {
    if (route.endsWith("/commits")) return { data: commits as TData };
    if (route.endsWith("/reviews")) return { data: reviews as TData };
    return { data: diff as TData };
  };

  return {
    request,
    pulls: {
      get: vi.fn(async () => ({
        data: {
          title: "feat: add payment flow",
          body: "This PR introduces payment screens.",
          user: { login: "octocat" },
          merged_at: mergedAt,
          head: { sha: "abc123" },
          base: { ref: "main" },
          merged_by: options.mergedBy ?? null,
        },
      })),
      listFiles: vi.fn(async ({ page }: { page: number }) => ({
        data: listFilesPages[page - 1] ?? [],
      })),
    },
  };
};

describe("sources/github/github-source execute", () => {
  it("should fetch merged pull request data with metadata files and diff", async () => {
    const appOctokit = buildAppOctokitMock(101, "installation-token");
    const installationOctokit = buildInstallationOctokitMock();
    const octokitFactory = vi
      .fn<(auth: string) => OctokitLike>()
      .mockReturnValueOnce(appOctokit)
      .mockReturnValueOnce(installationOctokit);
    const source = execute({
      appId: "123456",
      privateKey: buildPrivateKey(),
      octokitFactory,
    });

    const result = await source.fetchPullRequest("acme/mobile-app", 42);

    expect(result.repo).toBe("acme/mobile-app");
    expect(result.prNumber).toBe(42);
    expect(result.title).toBe("feat: add payment flow");
    expect(result.author).toBe("octocat");
    expect(result.baseBranch).toBe("main");
    expect(result.headSha).toBe("abc123");
    expect(result.files).toEqual([
      { path: "src/index.ts", additions: 10, deletions: 2 },
    ]);
    expect(result.diff).toContain("diff --git");
    expect(octokitFactory).toHaveBeenCalledTimes(2);
  });

  it("should paginate files and truncate large diff", async () => {
    const appOctokit = buildAppOctokitMock(101, "installation-token");
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      filename: `file-${index}.ts`,
      additions: 1,
      deletions: 0,
    }));
    const secondPage = [
      { filename: "file-101.ts", additions: 2, deletions: 1 },
    ];
    const installationOctokit = buildInstallationOctokitMock({
      listFilesPages: [firstPage, secondPage],
      diff: "x".repeat(120),
    });
    const source = execute({
      appId: "123456",
      privateKey: buildPrivateKey(),
      diffMaxBytes: 50,
      octokitFactory: vi
        .fn<(auth: string) => OctokitLike>()
        .mockReturnValueOnce(appOctokit)
        .mockReturnValueOnce(installationOctokit),
    });

    const result = await source.fetchPullRequest("acme/mobile-app", 99);

    expect(result.files.length).toBe(101);
    expect(result.diff).toContain("[diff truncated to 50 bytes]");
  });

  it("should collect explicit collaboration roles without retaining emails", async () => {
    const appOctokit = buildAppOctokitMock(101, "installation-token");
    const installationOctokit = buildInstallationOctokitMock({
      mergedBy: { login: "release-manager" },
      commits: [
        {
          author: { login: "octocat" },
          commit: {
            author: { name: "Octo Cat" },
            message:
              "feat: add payment flow\n\nCo-authored-by: Jane Dev <jane@example.com>",
          },
        },
        {
          author: { login: "dependabot[bot]", type: "Bot" },
          commit: {
            author: { name: "dependabot[bot]" },
            message: "chore: update dependency",
          },
        },
      ],
      reviews: [
        { user: { login: "reviewer-one" }, state: "APPROVED" },
        { user: { login: "reviewer-one" }, state: "COMMENTED" },
        { user: { login: "draft-reviewer" }, state: "PENDING" },
      ],
    });
    const source = execute({
      appId: "123456",
      privateKey: buildPrivateKey(),
      octokitFactory: vi
        .fn<(auth: string) => OctokitLike>()
        .mockReturnValueOnce(appOctokit)
        .mockReturnValueOnce(installationOctokit),
    });

    const result = await source.fetchPullRequest("acme/mobile-app", 42);

    expect(result.participants).toEqual([
      expect.objectContaining({
        externalIdentity: "github:octocat",
        role: "commit_author",
        isBot: false,
      }),
      expect.objectContaining({
        externalIdentity: "git-name:jane dev",
        displayName: "Jane Dev",
        role: "coauthor",
        sourceUrl: null,
      }),
      expect.objectContaining({
        externalIdentity: "github:dependabot[bot]",
        role: "commit_author",
        isBot: true,
      }),
      expect.objectContaining({
        externalIdentity: "github:reviewer-one",
        role: "reviewer",
      }),
      expect.objectContaining({
        externalIdentity: "github:release-manager",
        role: "merger",
      }),
    ]);
    expect(JSON.stringify(result.participants)).not.toContain(
      "jane@example.com",
    );
  });

  it("should throw when repository format is invalid", async () => {
    const source = execute({
      appId: "123456",
      privateKey: buildPrivateKey(),
      octokitFactory: vi.fn<(auth: string) => OctokitLike>(),
    });

    await expect(
      source.fetchPullRequest("invalid-repo", 1),
    ).rejects.toThrowError(/Invalid repository format/);
  });

  it("should throw when pull request is not merged", async () => {
    const appOctokit = buildAppOctokitMock(101, "installation-token");
    const installationOctokit = buildInstallationOctokitMock({
      mergedAt: null,
    });
    const source = execute({
      appId: "123456",
      privateKey: buildPrivateKey(),
      octokitFactory: vi
        .fn<(auth: string) => OctokitLike>()
        .mockReturnValueOnce(appOctokit)
        .mockReturnValueOnce(installationOctokit),
    });

    await expect(
      source.fetchPullRequest("acme/mobile-app", 2),
    ).rejects.toThrowError(/is not merged/);
  });
});
