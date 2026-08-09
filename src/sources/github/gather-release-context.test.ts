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

const pbxForBuild = (build: string, short = "1.0.0"): string => {
  return `MARKETING_VERSION = ${short};
CURRENT_PROJECT_VERSION = ${build};
`;
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
    expect(result.compareCommits).toEqual([
      { sha: "s1", message: "Merge pull request #5 from a/b" },
    ]);
  });

  it("should read version from project.pbxproj when projectPbxprojPath is set", async () => {
    const appOctokit = buildAppOctokitMock(7, "inst-token");
    const pbxPath = "App.xcodeproj/project.pbxproj";
    const installationRequest = (async (route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        const path = (parameters as { path?: string } | undefined)?.path;
        const ref = (parameters as { ref?: string } | undefined)?.ref;
        if (path !== pbxPath) {
          throw new Error(`Unexpected path: ${String(path)}`);
        }
        const text = ref === "beforebbb" ? pbxForBuild("1") : pbxForBuild("2");
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
            commits: [{ sha: "s1", commit: { message: "chore: bump" } }],
            html_url: "https://github.com/o/r/compare/before...after",
            files: [{ filename: pbxPath, status: "modified" }],
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
      projectPbxprojPath: pbxPath,
      octokitFactory,
    });
    expect(result.newVersionKey).toBe("1.0.0+2");
    expect(result.beforeVersion).toEqual({ short: "1.0.0", build: "1" });
  });

  it("should read version from Expo app.json when expoAppConfigPath is set", async () => {
    const appJson = JSON.stringify({
      expo: { version: "1.2.0", ios: { buildNumber: "55" } },
    });
    const appPath = "app.json";
    const appOctokit = buildAppOctokitMock(7, "inst-token");
    const installationRequest = (async (route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        const path = (parameters as { path?: string } | undefined)?.path;
        const text = path === appPath ? appJson : "";
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
            total_commits: 0,
            commits: [],
            html_url: "https://github.com/o/r/compare/before...after",
            files: [],
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
      infoPlistPath: "",
      expoAppConfigPath: appPath,
      octokitFactory,
    });
    expect(result.newVersionKey).toBe("1.2.0+55");
    expect(result.afterVersion).toEqual({ short: "1.2.0", build: "55" });
  });

  it("should read a web release from package.json without a mobile build number", async () => {
    const appOctokit = buildAppOctokitMock(7, "inst-token");
    const installationRequest = (async (route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        const ref = (parameters as { ref?: string } | undefined)?.ref;
        const text = JSON.stringify({
          name: "web-app",
          version: ref === "beforebbb" ? "2.0.0" : "2.1.0",
        });
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
            commits: [{ sha: "s1", commit: { message: "feat: web release" } }],
            html_url: "https://github.com/o/r/compare/before...after",
            files: [{ filename: "package.json", status: "modified" }],
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
      infoPlistPath: "",
      releaseProjectKind: "node_package",
      releaseVersionFilePath: "package.json",
      octokitFactory,
    });

    expect(result.previousVersionKey).toBe("2.0.0");
    expect(result.newVersionKey).toBe("2.1.0");
    expect(result.afterVersion).toEqual({ short: "2.1.0", build: "" });
  });

  it("should use compareBeforeSha only for GitHub compare, not for plist reads", async () => {
    const compareBefore = "w".repeat(40);
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
        const basehead = (parameters as { basehead?: string } | undefined)?.basehead;
        expect(basehead).toBe(`${compareBefore}...afterccc`);
        return {
          data: {
            total_commits: 0,
            commits: [],
            html_url: "https://github.com/o/r/compare/wide...after",
            files: [],
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

    await execute({
      appId: "1",
      privateKey: buildPrivateKey(),
      repo: "o/r",
      beforeSha: "beforebbb",
      afterSha: "afterccc",
      compareBeforeSha: compareBefore,
      infoPlistPath: "App/Info.plist",
      octokitFactory,
    });
  });

  it("execute should throw when plist has Xcode placeholders and pbx path unset", async () => {
    const placeholderPlist = `<?xml version="1.0"?><plist><dict>
<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
</dict></plist>`;
    const appOctokit = buildAppOctokitMock(1, "t");
    const installationRequest = (async (route) => {
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        return {
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(placeholderPlist, "utf8").toString("base64"),
          },
        };
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
      request: installationRequest,
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
    ).rejects.toThrow(/RELEASE_PROJECT_PBXPROJ_PATH/);
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
