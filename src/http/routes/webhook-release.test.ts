import { describe, expect, it } from "vitest";

import {
  buildProcessReleaseJobInput,
  refToBranch,
  pushTouchesPlistPath,
  pushTouchesReleasePaths,
} from "@/http/routes/webhook-release.js";

const relCfg = {
  branch: "develop" as const,
  versionWatchPaths: ["App/Info.plist"] as string[],
  monitoredRepo: null as string | null,
};

const basePush = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ref: "refs/heads/develop",
  before: "a".repeat(40),
  after: "b".repeat(40),
  repository: { full_name: "acme/ios" },
  commits: [{ modified: ["App/Info.plist"] }],
  ...overrides,
});

describe("http/routes/webhook-release", () => {
  it("queues a SemVer tag push and ignores non-version tags", () => {
    const config = { ...relCfg, strategy: "git_tag" as const };
    expect(
      buildProcessReleaseJobInput(
        "push",
        basePush({ ref: "refs/tags/v1.4.0", before: "0".repeat(40) }),
        config,
      ),
    ).toMatchObject({
      repo: "acme/ios",
      tagName: "v1.4.0",
      branch: "develop",
    });
    expect(
      buildProcessReleaseJobInput(
        "push",
        basePush({ ref: "refs/tags/latest" }),
        config,
      ),
    ).toBeNull();
  });

  it("queues only published GitHub Releases with SemVer tags", () => {
    const payload = {
      action: "published",
      repository: { full_name: "acme/ios" },
      release: {
        tag_name: "v2.0.0",
        target_commitish: "main",
        html_url: "https://github.com/acme/ios/releases/tag/v2.0.0",
        draft: false,
        published_at: "2026-08-09T18:00:00.000Z",
        created_at: "2026-08-09T17:00:00.000Z",
      },
    };
    const config = { ...relCfg, strategy: "github_release" as const };
    expect(buildProcessReleaseJobInput("release", payload, config)).toEqual({
      repo: "acme/ios",
      beforeSha: "main",
      afterSha: "v2.0.0",
      branch: "develop",
      tagName: "v2.0.0",
      sourceUrl: "https://github.com/acme/ios/releases/tag/v2.0.0",
      releasedAt: "2026-08-09T18:00:00.000Z",
    });
    expect(
      buildProcessReleaseJobInput(
        "release",
        { ...payload, release: { ...payload.release, draft: true } },
        config,
      ),
    ).toBeNull();
  });

  it("refToBranch should strip refs/heads", () => {
    expect(refToBranch("refs/heads/develop")).toBe("develop");
    expect(refToBranch("refs/tags/v1")).toBeNull();
    expect(refToBranch("refs/heads/")).toBeNull();
  });

  it("pushTouchesPlistPath should be true when commits list is empty or missing", () => {
    expect(pushTouchesPlistPath({ ...basePush(), commits: [] }, "App/Info.plist")).toBe(true);
    expect(
      pushTouchesPlistPath({ ...basePush(), commits: undefined }, "App/Info.plist"),
    ).toBe(true);
  });

  it("pushTouchesPlistPath should be false when path not in commits", () => {
    expect(
      pushTouchesPlistPath(
        { ...basePush(), commits: [{ modified: ["Other.swift"] }] },
        "App/Info.plist",
      ),
    ).toBe(false);
  });

  it("buildProcessReleaseJobInput should return payload for matching push", () => {
    const job = buildProcessReleaseJobInput("push", basePush() as Record<string, unknown>, relCfg);
    expect(job).toEqual({
      repo: "acme/ios",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      branch: "develop",
    });
  });

  it("buildProcessReleaseJobInput should respect monitored repo", () => {
    const job = buildProcessReleaseJobInput("push", basePush() as Record<string, unknown>, {
      ...relCfg,
      monitoredRepo: "other/ios",
    });
    expect(job).toBeNull();
  });

  it("buildProcessReleaseJobInput should return null when config missing or event not push", () => {
    expect(buildProcessReleaseJobInput("push", basePush() as Record<string, unknown>, null)).toBeNull();
    expect(
      buildProcessReleaseJobInput("pull_request", basePush() as Record<string, unknown>, relCfg),
    ).toBeNull();
  });

  it("buildProcessReleaseJobInput should return null for invalid payload or null shas", () => {
    const cfg = relCfg;
    expect(buildProcessReleaseJobInput("push", { foo: 1 } as Record<string, unknown>, cfg)).toBeNull();
    const b = basePush();
    expect(
      buildProcessReleaseJobInput(
        "push",
        { ...b, after: "0".repeat(40) } as Record<string, unknown>,
        cfg,
      ),
    ).toBeNull();
    expect(
      buildProcessReleaseJobInput(
        "push",
        { ...b, before: b.after } as Record<string, unknown>,
        cfg,
      ),
    ).toBeNull();
  });

  it("buildProcessReleaseJobInput should return null when ref is not the configured branch", () => {
    expect(
      buildProcessReleaseJobInput(
        "push",
        { ...basePush(), ref: "refs/heads/main" } as Record<string, unknown>,
        relCfg,
      ),
    ).toBeNull();
  });

  it("pushTouchesReleasePaths should be true when only project.pbxproj changed", () => {
    expect(
      pushTouchesReleasePaths(
        { commits: [{ modified: ["App.xcodeproj/project.pbxproj"] }] },
        ["App/Info.plist", "App.xcodeproj/project.pbxproj"],
      ),
    ).toBe(true);
  });

  it("pushTouchesReleasePaths should be false when pbx not touched and plist not touched", () => {
    expect(
      pushTouchesReleasePaths(
        { commits: [{ modified: ["Other.swift"] }] },
        ["App/Info.plist", "App.xcodeproj/project.pbxproj"],
      ),
    ).toBe(false);
  });

  it("pushTouchesReleasePaths should be true when app.config.js changed", () => {
    expect(
      pushTouchesReleasePaths({ commits: [{ modified: ["app.config.js"] }] }, ["app.config.js"]),
    ).toBe(true);
  });

  it("pushTouchesPlistPath should be true when 20 commits (github cap)", () => {
    const twenty = Array.from({ length: 20 }, () => ({ modified: ["x"] }));
    expect(pushTouchesPlistPath({ commits: twenty }, "App/Info.plist")).toBe(true);
  });

  it("pushTouchesPlistPath should match added and removed lists", () => {
    expect(
      pushTouchesPlistPath(
        { commits: [{ added: ["App/Info.plist"] }] },
        "App/Info.plist",
      ),
    ).toBe(true);
    expect(
      pushTouchesPlistPath(
        { commits: [{ removed: ["App/Info.plist"] }] },
        "App/Info.plist",
      ),
    ).toBe(true);
  });
});
