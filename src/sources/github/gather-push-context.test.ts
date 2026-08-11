import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { execute } from "@/sources/github/gather-push-context.js";
import type { OctokitLike } from "@/sources/github/github-installation.js";

const buildPrivateKey = (): string => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "pem", type: "pkcs1" }).toString();
};

const buildAppOctokit = (): OctokitLike => ({
  request: (async (route) => {
    if (route === "GET /repos/{owner}/{repo}/installation") {
      return { data: { id: 77 } as unknown };
    }
    if (route === "POST /app/installations/{installation_id}/access_tokens") {
      return { data: { token: "installation-token" } as unknown };
    }
    throw new Error(`Unexpected route ${String(route)}`);
  }) as OctokitLike["request"],
  pulls: { get: vi.fn(), listFiles: vi.fn() },
});

const buildFactory = (input: {
  compare: Record<string, unknown>;
  diff?: string;
}) => {
  const installation: OctokitLike = {
    request: (async (route, parameters) => {
      expect(parameters).toMatchObject({ owner: "acme", repo: "app" });
      if (
        route === "GET /repos/{owner}/{repo}/compare/{basehead}" &&
        (parameters as { headers?: unknown }).headers === undefined
      ) {
        return { data: input.compare as unknown };
      }
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
        expect(parameters).toMatchObject({
          headers: { accept: "application/vnd.github.v3.diff" },
        });
        return { data: (input.diff ?? "diff") as unknown };
      }
      throw new Error(`Unexpected route ${String(route)}`);
    }) as OctokitLike["request"],
    pulls: { get: vi.fn(), listFiles: vi.fn() },
  };

  return vi
    .fn<(auth: string) => OctokitLike>()
    .mockReturnValueOnce(buildAppOctokit())
    .mockReturnValueOnce(installation);
};

describe("sources/github/gather-push-context", () => {
  it("rejects branch creation/deletion and empty compare ranges early", async () => {
    const base = {
      appId: "1",
      privateKey: "unused",
      repo: "acme/app",
      octokitFactory: vi.fn<(auth: string) => OctokitLike>(),
    };

    await expect(
      execute({ ...base, beforeSha: "0".repeat(40), afterSha: "abc" }),
    ).rejects.toThrow("SHA nulo");
    await expect(
      execute({ ...base, beforeSha: "abc", afterSha: "0".repeat(40) }),
    ).rejects.toThrow("SHA nulo");
    await expect(
      execute({ ...base, beforeSha: " same ", afterSha: "same" }),
    ).rejects.toThrow("before SHA equals after SHA");
    expect(base.octokitFactory).not.toHaveBeenCalled();
  });

  it("builds a complete push context and bounds large evidence payloads", async () => {
    const files = Array.from({ length: 52 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
      status: index === 0 ? "added" : "modified",
      additions: index + 1,
      deletions: 1,
    }));
    const factory = buildFactory({
      compare: {
        commits: [
          { sha: "c1", commit: { message: " feat: checkout (#18) " } },
          { sha: "c2", commit: { message: "Merge pull request #7 from acme/fix" } },
        ],
        total_commits: 2,
        html_url: "https://github.com/acme/app/compare/before...after",
        files,
      },
      diff: "x".repeat(120),
    });

    const result = await execute({
      appId: "1",
      privateKey: buildPrivateKey(),
      repo: "acme/app",
      beforeSha: " before ",
      afterSha: " after ",
      diffMaxBytes: 50,
      octokitFactory: factory,
    });

    expect(result.compareCommits).toEqual([
      { sha: "c1", message: "feat: checkout (#18)" },
      { sha: "c2", message: "Merge pull request #7 from acme/fix" },
    ]);
    expect(result.prNumbers).toEqual([7, 18]);
    expect(result.totalCommits).toBe(2);
    expect(result.additions).toBe(1378);
    expect(result.deletions).toBe(52);
    expect(result.changedFiles).toBe(52);
    expect(result.fileChangeSummary).toContain("added: src/file-0.ts");
    expect(result.fileChangeSummary).toContain("… e mais 2 arquivos.");
    expect(result.diff).toBe(`${"x".repeat(50)}\n\n[diff truncated to 50 bytes]`);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("represents compares without files and preserves a small diff", async () => {
    const factory = buildFactory({
      compare: {
        commits: [],
        total_commits: 0,
        html_url: "https://github.com/acme/app/compare/a...b",
      },
      diff: "small diff",
    });

    const result = await execute({
      appId: "1",
      privateKey: buildPrivateKey(),
      repo: "acme/app",
      beforeSha: "a",
      afterSha: "b",
      octokitFactory: factory,
    });

    expect(result).toMatchObject({
      compareCommits: [],
      commitMessages: [],
      prNumbers: [],
      additions: null,
      deletions: null,
      changedFiles: null,
      diff: "small diff",
      fileChangeSummary: "Nenhum arquivo listado no compare (ou alterações apenas em binário).",
    });
  });
});
