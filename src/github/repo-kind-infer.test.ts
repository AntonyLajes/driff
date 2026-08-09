import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";

import { inferRepoKind } from "@/github/repo-kind-infer.js";

type RootEntry = {
  type: "file" | "dir";
  name: string;
  path?: string;
};

const encoded = (value: string) => ({
  type: "file" as const,
  encoding: "base64",
  content: Buffer.from(value, "utf8").toString("base64"),
});

const buildOctokit = (input: {
  root?: RootEntry[] | Record<string, unknown>;
  files?: Record<string, unknown | Error>;
  defaultBranch?: string | null;
}) => {
  const get = vi.fn(async () => ({
    data: {
      full_name: "acme/app",
      default_branch: input.defaultBranch ?? null,
    },
  }));
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    if (path === "") {
      return { data: input.root ?? [] };
    }
    const value = input.files?.[path];
    if (value instanceof Error || value === undefined) {
      throw value ?? new Error(`missing ${path}`);
    }
    return { data: value };
  });

  return {
    octokit: { rest: { repos: { get, getContent } } } as unknown as Octokit,
    get,
    getContent,
  };
};

describe("github/repo-kind-infer", () => {
  it("rejects malformed repository names before calling GitHub", async () => {
    const { octokit, get } = buildOctokit({});

    await expect(inferRepoKind(octokit, "missing-slash")).rejects.toThrow(
      "invalid_full_name",
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("reports when the repository root is not a directory listing", async () => {
    const { octokit } = buildOctokit({
      root: { type: "file" },
      defaultBranch: "main",
    });

    await expect(inferRepoKind(octokit, " acme/app ")).resolves.toEqual({
      suggestedKind: null,
      confidence: null,
      defaultBranch: "main",
      versionFilePath: null,
      signals: ["github:acme/app", "root_not_directory_listing"],
    });
  });

  it("detects Flutter from pubspec without extra file reads", async () => {
    const { octokit, getContent } = buildOctokit({
      root: [{ type: "file", name: "pubspec.yaml" }],
      defaultBranch: "develop",
    });

    await expect(inferRepoKind(octokit, "acme/app")).resolves.toMatchObject({
      suggestedKind: "flutter_pubspec",
      confidence: "high",
      defaultBranch: "develop",
      versionFilePath: "pubspec.yaml",
    });
    expect(getContent).toHaveBeenCalledTimes(1);
  });

  it("detects Expo and prefers the first available config file", async () => {
    const { octokit } = buildOctokit({
      root: [
        { type: "file", name: "package.json" },
        { type: "file", name: "app.json" },
        { type: "file", name: "app.config.ts" },
      ],
      files: {
        "package.json": encoded(JSON.stringify({ dependencies: { expo: "latest" } })),
      },
      defaultBranch: "main",
    });

    await expect(inferRepoKind(octokit, "acme/app")).resolves.toEqual({
      suggestedKind: "react_native_expo",
      confidence: "high",
      defaultBranch: "main",
      versionFilePath: "app.json",
      signals: ["github:acme/app", "dependency:expo", "file:app.json"],
    });
  });

  it("keeps a low-confidence Expo suggestion when the config is missing", async () => {
    const { octokit } = buildOctokit({
      root: [{ type: "file", name: "package.json" }],
      files: {
        "package.json": encoded(JSON.stringify({ devDependencies: { expo: "52" } })),
      },
    });

    await expect(inferRepoKind(octokit, "acme/app")).resolves.toMatchObject({
      suggestedKind: "react_native_expo",
      confidence: "low",
      versionFilePath: null,
      signals: ["github:acme/app", "dependency:expo", "missing_expo_config_file"],
    });
  });

  it("detects the Android version file in a React Native repository", async () => {
    const { octokit } = buildOctokit({
      root: [
        { type: "file", name: "package.json" },
        { type: "dir", name: "android" },
      ],
      files: {
        "package.json": encoded(
          JSON.stringify({ dependencies: { "react-native": "0.80" } }),
        ),
        "android/app/build.gradle": { type: "file" },
      },
    });

    await expect(inferRepoKind(octokit, "acme/app")).resolves.toMatchObject({
      suggestedKind: "android_gradle",
      confidence: "low",
      versionFilePath: "android/app/build.gradle",
    });
  });

  it("detects direct and nested iOS plists", async () => {
    const direct = buildOctokit({
      root: [{ type: "dir", name: "ios" }],
      files: {
        ios: [
          { type: "file", name: "Info.plist", path: "ios/Info.plist" },
        ],
      },
    });
    await expect(inferRepoKind(direct.octokit, "acme/app")).resolves.toMatchObject({
      suggestedKind: "ios_plist",
      confidence: "medium",
      versionFilePath: "ios/Info.plist",
    });

    const nested = buildOctokit({
      root: [{ type: "dir", name: "ios" }],
      files: {
        ios: [{ type: "dir", name: "Runner", path: "ios/Runner" }],
        "ios/Runner/Info.plist": { type: "file" },
      },
    });
    await expect(inferRepoKind(nested.octokit, "acme/app")).resolves.toMatchObject({
      suggestedKind: "ios_plist",
      confidence: "low",
      versionFilePath: "ios/Runner/Info.plist",
    });
  });

  it("falls back to Xcode and native Android project files", async () => {
    const xcode = buildOctokit({
      root: [{ type: "dir", name: "App.xcodeproj" }],
      files: { "App.xcodeproj/project.pbxproj": { type: "file" } },
    });
    await expect(inferRepoKind(xcode.octokit, "acme/app")).resolves.toMatchObject({
      suggestedKind: "ios_pbx",
      confidence: "medium",
      versionFilePath: "App.xcodeproj/project.pbxproj",
    });

    const android = buildOctokit({
      root: [{ type: "dir", name: "android" }],
      files: { "android/app/build.gradle": { type: "file" } },
    });
    await expect(inferRepoKind(android.octokit, "acme/app")).resolves.toMatchObject({
      suggestedKind: "android_gradle",
      confidence: "medium",
      versionFilePath: "android/app/build.gradle",
    });
  });

  it("returns evidence about unreadable candidates instead of failing inference", async () => {
    const { octokit } = buildOctokit({
      root: [
        { type: "file", name: "package.json" },
        { type: "dir", name: "ios" },
        { type: "dir", name: "Broken.xcodeproj" },
        { type: "dir", name: "android" },
      ],
      files: {
        "package.json": encoded("not-json"),
        ios: new Error("forbidden"),
        "Broken.xcodeproj/project.pbxproj": new Error("missing"),
        "android/app/build.gradle": new Error("missing"),
      },
    });

    await expect(inferRepoKind(octokit, "acme/app")).resolves.toEqual({
      suggestedKind: null,
      confidence: null,
      defaultBranch: null,
      versionFilePath: null,
      signals: [
        "github:acme/app",
        "package_json_invalid",
        "ios_folder_unreadable",
        "pbxproj_missing",
        "android_gradle_missing",
      ],
    });
  });
});
