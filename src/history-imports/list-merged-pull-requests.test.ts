import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { execute } from "@/history-imports/list-merged-pull-requests.js";
import type { OctokitLike } from "@/sources/github/github-installation.js";

const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs1" })
  .toString();

const appOctokit = (): OctokitLike => ({
  request: vi.fn(async (route: string) => {
    if (route === "GET /repos/{owner}/{repo}/installation") {
      return { data: { id: 7 } as unknown };
    }
    return { data: { token: "installation-token" } as unknown };
  }) as OctokitLike["request"],
  pulls: { get: vi.fn(), listFiles: vi.fn() },
});

const installationOctokit = (pages: unknown[]): OctokitLike => ({
  request: vi.fn(async () => ({
    data: pages.shift() ?? [],
  })) as OctokitLike["request"],
  pulls: { get: vi.fn(), listFiles: vi.fn() },
});

describe("history-imports/list-merged-pull-requests", () => {
  it("should return recent merged pull requests oldest first", async () => {
    const installation = installationOctokit([
      [
        {
          number: 12,
          merged_at: "2026-08-08T12:00:00.000Z",
          updated_at: "2026-08-08T12:00:00.000Z",
        },
        {
          number: 11,
          merged_at: null,
          updated_at: "2026-08-07T12:00:00.000Z",
        },
        {
          number: 10,
          merged_at: "2026-07-08T12:00:00.000Z",
          updated_at: "2026-07-08T12:00:00.000Z",
        },
      ],
    ]);
    const octokitFactory = vi
      .fn<(auth: string) => OctokitLike>()
      .mockReturnValueOnce(appOctokit())
      .mockReturnValueOnce(installation);
    const lister = execute({
      appId: "1",
      privateKey: PRIVATE_KEY,
      octokitFactory,
      pageSize: 100,
    });

    const result = await lister.list({
      repo: "acme/mobile",
      since: new Date("2026-06-01T00:00:00.000Z"),
      maxPullRequests: 100,
    });

    expect(result).toEqual({
      pullRequests: [
        { prNumber: 10, mergedAt: new Date("2026-07-08T12:00:00.000Z") },
        { prNumber: 12, mergedAt: new Date("2026-08-08T12:00:00.000Z") },
      ],
      truncated: false,
    });
  });

  it("should stop at the configured limit and report truncation", async () => {
    const installation = installationOctokit([
      Array.from({ length: 11 }, (_, index) => ({
        number: 20 - index,
        merged_at: `2026-08-${String(20 - index).padStart(2, "0")}T12:00:00.000Z`,
        updated_at: `2026-08-${String(20 - index).padStart(2, "0")}T12:00:00.000Z`,
      })),
    ]);
    const lister = execute({
      appId: "1",
      privateKey: PRIVATE_KEY,
      octokitFactory: vi
        .fn<(auth: string) => OctokitLike>()
        .mockReturnValueOnce(appOctokit())
        .mockReturnValueOnce(installation),
      pageSize: 100,
    });

    const result = await lister.list({
      repo: "acme/mobile",
      since: new Date("2026-01-01T00:00:00.000Z"),
      maxPullRequests: 10,
    });

    expect(result.pullRequests).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it("should reject malformed GitHub responses", async () => {
    const lister = execute({
      appId: "1",
      privateKey: PRIVATE_KEY,
      octokitFactory: vi
        .fn<(auth: string) => OctokitLike>()
        .mockReturnValueOnce(appOctokit())
        .mockReturnValueOnce(installationOctokit([{ nope: true }])),
    });

    await expect(
      lister.list({
        repo: "acme/mobile",
        since: new Date("2026-01-01T00:00:00.000Z"),
        maxPullRequests: 10,
      }),
    ).rejects.toThrow("invalid pull request history response");
  });

  it("should paginate while pages contain recent updates", async () => {
    const installation = installationOctokit([
      [
        {
          number: 4,
          merged_at: "2026-08-04T12:00:00.000Z",
          updated_at: "2026-08-04T12:00:00.000Z",
        },
        {
          number: 3,
          merged_at: "2026-08-03T12:00:00.000Z",
          updated_at: "2026-08-03T12:00:00.000Z",
        },
      ],
      [
        {
          number: 2,
          merged_at: "2026-08-02T12:00:00.000Z",
          updated_at: "2026-08-02T12:00:00.000Z",
        },
      ],
    ]);
    const lister = execute({
      appId: "1",
      privateKey: PRIVATE_KEY,
      octokitFactory: vi
        .fn<(auth: string) => OctokitLike>()
        .mockReturnValueOnce(appOctokit())
        .mockReturnValueOnce(installation),
      pageSize: 2,
    });

    const result = await lister.list({
      repo: "acme/mobile",
      since: new Date("2026-08-01T00:00:00.000Z"),
      maxPullRequests: 10,
    });

    expect(result.pullRequests.map(({ prNumber }) => prNumber)).toEqual([
      2, 3, 4,
    ]);
    expect(installation.request).toHaveBeenCalledTimes(2);
  });

  it("should stop pagination when a full page is older than the window", async () => {
    const installation = installationOctokit([
      [
        {
          number: 2,
          merged_at: "2025-01-02T12:00:00.000Z",
          updated_at: "2025-01-02T12:00:00.000Z",
        },
        {
          number: 1,
          merged_at: "2025-01-01T12:00:00.000Z",
          updated_at: "2025-01-01T12:00:00.000Z",
        },
      ],
    ]);
    const lister = execute({
      appId: "1",
      privateKey: PRIVATE_KEY,
      octokitFactory: vi
        .fn<(auth: string) => OctokitLike>()
        .mockReturnValueOnce(appOctokit())
        .mockReturnValueOnce(installation),
      pageSize: 2,
    });

    const result = await lister.list({
      repo: "acme/mobile",
      since: new Date("2026-01-01T00:00:00.000Z"),
      maxPullRequests: 10,
    });

    expect(result.pullRequests).toEqual([]);
    expect(installation.request).toHaveBeenCalledTimes(1);
  });
});
