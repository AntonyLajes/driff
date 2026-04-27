import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { execute, extractPrNumbersFromCommitMessages } from "@/sources/github/gather-release-context.js";
import type { OctokitLike } from "@/sources/github/github-installation.js";

const plistForBuild = (build: string, short = "1.0.0"): string => {
  return `<?xml version="1.0"?><plist><dict>
<key>CFBundleShortVersionString</key><string>${short}</string>
<key>CFBundleVersion</key><string>${build}</string>
</dict></plist>`;
};

const buildPrivateKey = (): string => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "pem", type: "pkcs1" }).toString();
};

const buildAppOctokitMock = (installationId: number, token: string): OctokitLike => {
  const request = (async (route) => {
    if (route === "GET /repos/{owner}/{repo}/installation") {
      return { data: { id: installationId } as unknown };
    }
    if (route === "POST /app/installations/{installation_id}/access_tokens") {
      return { data: { token } as unknown };
    }
    throw new Error(`Unexpected app route: ${String(route)}`);
  }) as OctokitLike["request"];
  return { request, pulls: { get: vi.fn(), listFiles: vi.fn() } };
};

describe("sources/github/gather-release-context extractPrNumbersFromCommitMessages", () => {
  it("should extract numbers from merge commits and squash messages", () => {
    expect(
      extractPrNumbersFromCommitMessages([
        "Merge pull request #42 from acme/feat",
        "fix: something (#7)",
      ]),
    ).toEqual([7, 42]);
  });
});

describe("sources/github/gather-release-context execute", () => {
  it("should build context from plists and compare", async () => {
    const appOctokit = buildAppOctokitMock(7, "inst-token");
    const installationRequest = (async (route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        const ref = (parameters as { ref?: string } | undefined)?.ref;
        const text =
          ref === "beforebbb"
            ? plistForBuild("1")
            : plistForBuild("2", "1.0.0");
        return {
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(text, "utf8").toString("base64"),
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
        return {
          data: {
            total_commits: 1,
            commits: [
              { sha: "s1", commit: { message: "Merge pull request #5 from a/b" } },
            ],
            html_url: "https://github.com/o/r/compare/before...after",
            files: [{ filename: "App/Info.plist", status: "modified" }],
          },
        };
      }
      throw new Error(`Unexpected installation route: ${String(route)}`);
    }) as OctokitLike["request"];
    const installationOctokit: OctokitLike = {
      request: installationRequest,
      pulls: { get: vi.fn(), listFiles: vi.fn() },
    };
    const octokitFactory = vi
      .fn<(auth: string) => OctokitLike>()
      .mockReturnValueOnce(appOctokit)
      .mockReturnValueOnce(installationOctokit);

    const result = await execute({
      appId: "1",
      privateKey: buildPrivateKey(),
      repo: "o/r",
      beforeSha: "beforebbb",
      afterSha: "afterccc",
      infoPlistPath: "App/Info.plist",
      octokitFactory,
    });
    expect(result.newVersionKey).toBe("1.0.0+2");
    expect(result.prNumbers).toEqual([5]);
    expect(result.totalCommits).toBe(1);
  });

  it("execute should throw when before or after sha is all zeros", async () => {
    await expect(
      execute({
        appId: "1",
        privateKey: buildPrivateKey(),
        repo: "o/r",
        beforeSha: "0".repeat(40),
        afterSha: "a".repeat(40),
        infoPlistPath: "p",
        octokitFactory: vi
          .fn()
          .mockReturnValue({ request: vi.fn(), pulls: { get: vi.fn(), listFiles: vi.fn() } }),
      }),
    ).rejects.toThrow(/Ref inválida/);
  });

  it("execute should throw when contents response is not a file", async () => {
    const appOctokit = buildAppOctokitMock(1, "t");
    const badContent = (async (route) => {
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        return { data: { type: "dir" } };
      }
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
        return {
          data: {
            total_commits: 0,
            commits: [],
            html_url: "u",
            files: [],
          },
        };
      }
      throw new Error(route);
    }) as OctokitLike["request"];
    const installationOctokit: OctokitLike = {
      request: badContent,
      pulls: { get: vi.fn(), listFiles: vi.fn() },
    };
    await expect(
      execute({
        appId: "1",
        privateKey: buildPrivateKey(),
        repo: "o/r",
        beforeSha: "a".repeat(40),
        afterSha: "b".repeat(40),
        infoPlistPath: "p",
        octokitFactory: vi
          .fn<(auth: string) => OctokitLike>()
          .mockReturnValueOnce(appOctokit)
          .mockReturnValueOnce(installationOctokit),
      }),
    ).rejects.toThrow(/Expected a single file/);
  });
});
