import { beforeEach, describe, expect, it, vi } from "vitest";

import { execute } from "@/jobs/resolve-release-compare-before.js";

const createSequentialDb = (limitResults: unknown[][]): { select: ReturnType<typeof vi.fn> } => {
  let idx = 0;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              const rows = limitResults[idx] ?? [];
              idx += 1;
              return rows;
            }),
          })),
        })),
      })),
    })),
  };
};

describe("jobs/resolve-release-compare-before execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return latest head_sha on same short_version for build-only bump", async () => {
    const priorSha = "p".repeat(40);
    const db = createSequentialDb([[{ headSha: priorSha }]]);
    const result = await execute({
      db: db as never,
      repo: "o/r",
      branch: "develop",
      beforeVersion: { short: "213", build: "1" },
      afterVersion: { short: "213", build: "2" },
      webhookBeforeSha: "w".repeat(40),
      releaseCompareRootSha: null,
    });
    expect(result).toBe(priorSha);
  });

  it("should fall back to webhook before when no prior release and root unset", async () => {
    const webhook = "w".repeat(40);
    const db = createSequentialDb([[]]);
    const result = await execute({
      db: db as never,
      repo: "o/r",
      branch: "develop",
      beforeVersion: { short: "213", build: "1" },
      afterVersion: { short: "213", build: "2" },
      webhookBeforeSha: webhook,
      releaseCompareRootSha: null,
    });
    expect(result).toBe(webhook);
  });

  it("should fall back to RELEASE_COMPARE_ROOT_SHA when no prior release on marketing line", async () => {
    const root = "r".repeat(40);
    const db = createSequentialDb([[]]);
    const result = await execute({
      db: db as never,
      repo: "o/r",
      branch: "develop",
      beforeVersion: { short: "213", build: "1" },
      afterVersion: { short: "213", build: "2" },
      webhookBeforeSha: "w".repeat(40),
      releaseCompareRootSha: root,
    });
    expect(result).toBe(root);
  });

  it("should return earliest marketing_era_start_sha for old marketing on marketing bump", async () => {
    const era = "e".repeat(40);
    const db = createSequentialDb([[{ marketingEraStartSha: era }]]);
    const result = await execute({
      db: db as never,
      repo: "o/r",
      branch: "develop",
      beforeVersion: { short: "213", build: "5" },
      afterVersion: { short: "214", build: "1" },
      webhookBeforeSha: "w".repeat(40),
      releaseCompareRootSha: null,
    });
    expect(result).toBe(era);
  });

  it("should fall back to last head on old short when era anchor is missing", async () => {
    const last = "l".repeat(40);
    const db = createSequentialDb([[], [{ headSha: last }]]);
    const result = await execute({
      db: db as never,
      repo: "o/r",
      branch: "develop",
      beforeVersion: { short: "213", build: "5" },
      afterVersion: { short: "214", build: "1" },
      webhookBeforeSha: "w".repeat(40),
      releaseCompareRootSha: null,
    });
    expect(result).toBe(last);
  });

  it("should return webhook before when marketing bump has no rows on old line", async () => {
    const webhook = "w".repeat(40);
    const db = createSequentialDb([[], []]);
    const result = await execute({
      db: db as never,
      repo: "o/r",
      branch: "develop",
      beforeVersion: { short: "213", build: "5" },
      afterVersion: { short: "214", build: "1" },
      webhookBeforeSha: webhook,
      releaseCompareRootSha: null,
    });
    expect(result).toBe(webhook);
  });

  it("should return webhook before when beforeVersion is null", async () => {
    const webhook = "w".repeat(40);
    const db = createSequentialDb([]);
    const result = await execute({
      db: db as never,
      repo: "o/r",
      branch: "develop",
      beforeVersion: null,
      afterVersion: { short: "1", build: "1" },
      webhookBeforeSha: webhook,
      releaseCompareRootSha: null,
    });
    expect(result).toBe(webhook);
    expect(db.select).not.toHaveBeenCalled();
  });
});
