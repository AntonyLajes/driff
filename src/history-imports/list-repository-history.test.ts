import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { execute } from "@/history-imports/list-repository-history.js";
import type { OctokitLike } from "@/sources/github/github-installation.js";

const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs1" })
  .toString();

const appOctokit = (): OctokitLike => ({
  request: vi.fn(async (route: string) =>
    route.includes("installation")
      ? { data: { id: 7 } as unknown }
      : { data: { token: "installation-token" } as unknown },
  ) as OctokitLike["request"],
  pulls: { get: vi.fn(), listFiles: vi.fn() },
});

const commit = (sha: string, date: string, parent = `${sha}-parent`) => ({
  sha,
  parents: [{ sha: parent }],
  author: { login: "octocat" },
  commit: {
    author: { name: "Octo Cat", date },
    committer: { date },
  },
});

const listerFor = (installation: OctokitLike, pageSize = 100) =>
  execute({
    appId: "1",
    privateKey: PRIVATE_KEY,
    octokitFactory: vi
      .fn<(auth: string) => OctokitLike>()
      .mockReturnValueOnce(appOctokit())
      .mockReturnValueOnce(installation),
    pageSize,
  });

describe("history-imports/list-repository-history", () => {
  it("lists published GitHub Releases and preserves their canonical URLs", async () => {
    const installation = {
      request: vi.fn(async (route: string, parameters?: Record<string, unknown>) => {
        if (route === "GET /repos/{owner}/{repo}") {
          return { data: { default_branch: "main" } };
        }
        if (route === "GET /repos/{owner}/{repo}/commits") return { data: [] };
        if (route === "GET /repos/{owner}/{repo}/releases") {
          return {
            data: [
              {
                tag_name: "v1.2.0",
                html_url: "https://github.com/acme/mobile/releases/tag/v1.2.0",
                draft: false,
                published_at: "2026-08-03T12:00:00.000Z",
                created_at: "2026-08-03T11:00:00.000Z",
              },
              {
                tag_name: "latest",
                html_url: "https://github.com/acme/mobile/releases/tag/latest",
                draft: false,
                published_at: "2026-08-04T12:00:00.000Z",
                created_at: "2026-08-04T11:00:00.000Z",
              },
            ],
          };
        }
        expect(parameters?.ref).toBe("v1.2.0");
        return { data: commit("c2", "2026-08-03T10:00:00.000Z", "c1") };
      }) as OctokitLike["request"],
      pulls: { get: vi.fn(), listFiles: vi.fn() },
    } satisfies OctokitLike;

    const result = await listerFor(installation).list({
      repo: "acme/mobile",
      since: new Date("2026-08-01T00:00:00.000Z"),
      maxItems: 10,
      versionStrategy: "github_release",
    });

    expect(result.releases).toEqual([
      expect.objectContaining({
        tagName: "v1.2.0",
        beforeSha: "c1",
        afterSha: "c2",
        sourceUrl: "https://github.com/acme/mobile/releases/tag/v1.2.0",
        releasedAt: new Date("2026-08-03T12:00:00.000Z"),
      }),
    ]);
  });

  it("should list chronological commits and version tags with compare anchors", async () => {
    const installation = {
      request: vi.fn(
        async (route: string, parameters?: Record<string, unknown>) => {
          if (route === "GET /repos/{owner}/{repo}") {
            return { data: { default_branch: "main" } };
          }
          if (route === "GET /repos/{owner}/{repo}/commits") {
            return {
              data: [
                commit("c2", "2026-08-02T12:00:00.000Z", "c1"),
                commit("c1", "2026-08-01T12:00:00.000Z", "c0"),
              ],
            };
          }
          if (route === "GET /repos/{owner}/{repo}/tags") {
            return {
              data: [
                { name: "v1.1.0", commit: { sha: "c2" } },
                { name: "v1.0.0", commit: { sha: "c1" } },
              ],
            };
          }
          const ref = String(parameters?.ref);
          return {
            data:
              ref === "v1.1.0"
                ? commit("c2", "2026-08-02T12:00:00.000Z", "c1")
                : commit("c1", "2026-08-01T12:00:00.000Z", "c0"),
          };
        },
      ) as OctokitLike["request"],
      pulls: { get: vi.fn(), listFiles: vi.fn() },
    } satisfies OctokitLike;
    const lister = listerFor(installation);

    const result = await lister.list({
      repo: "acme/mobile",
      since: new Date("2026-07-01T00:00:00.000Z"),
      maxItems: 10,
    });

    expect(result.defaultBranch).toBe("main");
    expect(result.commits.map(({ sha }) => sha)).toEqual(["c1", "c2"]);
    expect(result.releases).toEqual([
      expect.objectContaining({
        tagName: "v1.0.0",
        beforeSha: "c0",
        afterSha: "c1",
      }),
      expect.objectContaining({
        tagName: "v1.1.0",
        beforeSha: "c1",
        afterSha: "c2",
      }),
    ]);
    expect(result.truncated).toBe(false);
  });

  it("should reject malformed provider responses", async () => {
    const installation = {
      request: vi.fn(async () => ({
        data: { nope: true },
      })) as OctokitLike["request"],
      pulls: { get: vi.fn(), listFiles: vi.fn() },
    } satisfies OctokitLike;
    const lister = listerFor(installation);

    await expect(
      lister.list({ repo: "acme/mobile", since: new Date(), maxItems: 10 }),
    ).rejects.toThrow("invalid repository metadata");
  });

  it("should enforce commit and tag limits", async () => {
    const installation = {
      request: vi.fn(
        async (route: string, parameters?: Record<string, unknown>) => {
          if (route === "GET /repos/{owner}/{repo}") {
            return { data: { default_branch: "develop" } };
          }
          if (route === "GET /repos/{owner}/{repo}/commits") {
            return {
              data: [
                commit("c2", "2026-08-02T12:00:00.000Z", "c1"),
                commit("c1", "2026-08-01T12:00:00.000Z", "c0"),
              ],
            };
          }
          if (route === "GET /repos/{owner}/{repo}/tags") {
            return {
              data: [
                { name: "v1.1.0", commit: { sha: "c2" } },
                { name: "v1.0.0", commit: { sha: "c1" } },
              ],
            };
          }
          const ref = String(parameters?.ref);
          return {
            data:
              ref === "v1.1.0"
                ? commit("c2", "2026-08-02T12:00:00.000Z", "c1")
                : commit("c1", "2026-08-01T12:00:00.000Z", "c0"),
          };
        },
      ) as OctokitLike["request"],
      pulls: { get: vi.fn(), listFiles: vi.fn() },
    } satisfies OctokitLike;

    const result = await listerFor(installation, 2).list({
      repo: "acme/mobile",
      since: new Date("2026-01-01T00:00:00.000Z"),
      maxItems: 1,
    });

    expect(result.commits).toHaveLength(1);
    expect(result.releases).toEqual([
      expect.objectContaining({ tagName: "v1.0.0", beforeSha: "c0" }),
    ]);
    expect(result.truncated).toBe(true);
  });

  it("should use author fallbacks and ignore unusable history entries", async () => {
    const fallbackCommit = {
      ...commit("fallback", "2026-08-03T12:00:00.000Z", "base"),
      author: null,
      commit: {
        author: { name: "Fallback Author", date: "2026-08-03T12:00:00.000Z" },
        committer: null,
      },
    };
    const rootCommit = {
      ...commit("root", "2026-08-02T12:00:00.000Z"),
      parents: [],
    };
    const invalidCommit = commit("invalid", "not-a-date");
    const oldCommit = commit("old", "2025-01-01T00:00:00.000Z");
    const anonymousCommit = {
      ...commit("anonymous", "2026-08-04T12:00:00.000Z", "fallback"),
      author: null,
      commit: {
        author: null,
        committer: { date: "2026-08-04T12:00:00.000Z" },
      },
    };
    const noDateCommit = {
      ...commit("no-date", "2026-08-05T12:00:00.000Z"),
      commit: { author: null, committer: null },
    };
    const installation = {
      request: vi.fn(
        async (route: string, parameters?: Record<string, unknown>) => {
          if (route === "GET /repos/{owner}/{repo}") {
            return { data: { default_branch: "main" } };
          }
          if (route === "GET /repos/{owner}/{repo}/commits") {
            return {
              data: [
                fallbackCommit,
                anonymousCommit,
                rootCommit,
                invalidCommit,
                oldCommit,
                noDateCommit,
              ],
            };
          }
          if (route === "GET /repos/{owner}/{repo}/tags") {
            return { data: [{ name: "root-tag", commit: { sha: "root" } }] };
          }
          expect(parameters?.ref).toBe("root-tag");
          return { data: rootCommit };
        },
      ) as OctokitLike["request"],
      pulls: { get: vi.fn(), listFiles: vi.fn() },
    } satisfies OctokitLike;

    const result = await listerFor(installation).list({
      repo: "acme/mobile",
      since: new Date("2026-01-01T00:00:00.000Z"),
      maxItems: 10,
    });

    expect(result.commits).toEqual([
      expect.objectContaining({ sha: "fallback", pusher: "Fallback Author" }),
      expect.objectContaining({ sha: "anonymous", pusher: null }),
    ]);
    expect(result.releases).toEqual([]);
  });

  it("should paginate commit history until GitHub returns an empty page", async () => {
    let commitPage = 0;
    const installation = {
      request: vi.fn(async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}") {
          return { data: { default_branch: "main" } };
        }
        if (route === "GET /repos/{owner}/{repo}/commits") {
          commitPage += 1;
          return {
            data:
              commitPage === 1
                ? [commit("c1", "2026-08-01T00:00:00.000Z", "c0")]
                : [],
          };
        }
        return { data: [] };
      }) as OctokitLike["request"],
      pulls: { get: vi.fn(), listFiles: vi.fn() },
    } satisfies OctokitLike;

    const result = await listerFor(installation, 1).list({
      repo: "acme/mobile",
      since: new Date("2026-01-01T00:00:00.000Z"),
      maxItems: 10,
    });

    expect(commitPage).toBe(2);
    expect(result.commits).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it.each([
    [
      "commits",
      "GET /repos/{owner}/{repo}/commits",
      "invalid commit history response",
    ],
    ["tags", "GET /repos/{owner}/{repo}/tags", "invalid tag history response"],
    [
      "tag metadata",
      "GET /repos/{owner}/{repo}/commits/{ref}",
      "invalid metadata for tag",
    ],
  ])("should reject malformed %s", async (_label, malformedRoute, message) => {
    const installation = {
      request: vi.fn(async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}") {
          return { data: { default_branch: "main" } };
        }
        if (route === "GET /repos/{owner}/{repo}/commits") {
          return { data: malformedRoute === route ? { nope: true } : [] };
        }
        if (route === "GET /repos/{owner}/{repo}/tags") {
          return {
            data:
              malformedRoute === route
                ? { nope: true }
                : [{ name: "v1", commit: { sha: "c1" } }],
          };
        }
        return {
          data:
            malformedRoute === route
              ? { nope: true }
              : commit("c1", "2026-08-01T00:00:00.000Z"),
        };
      }) as OctokitLike["request"],
      pulls: { get: vi.fn(), listFiles: vi.fn() },
    } satisfies OctokitLike;

    await expect(
      listerFor(installation).list({
        repo: "acme/mobile",
        since: new Date("2026-01-01T00:00:00.000Z"),
        maxItems: 10,
      }),
    ).rejects.toThrow(message);
  });
});
