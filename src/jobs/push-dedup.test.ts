import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client.js";
import { findPushOverlap } from "@/jobs/push-dedup.js";

/** Each entry is the rows returned by the next `.limit(1)` call, in order. */
const buildDb = (results: Array<Array<{ id: string }>>) => {
  let call = 0;
  const limit = vi.fn(async () => results[call++] ?? []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select } as unknown as Database;
};

const base = { repo: "acme/app", afterSha: "b".repeat(40) };

describe("jobs/push-dedup findPushOverlap", () => {
  it("skips when a process_release job exists for the same afterSha", async () => {
    const db = buildDb([[{ id: "release-job" }]]);
    const result = await findPushOverlap({ db, ...base, prNumbers: [] });
    expect(result).toEqual({ skip: true, reason: "release_push" });
  });

  it("skips when every referenced PR has a process_pr job", async () => {
    // Release job/source -> none; then one job query per PR -> both present.
    const db = buildDb([[], [], [{ id: "pr-7" }], [{ id: "pr-8" }]]);
    const result = await findPushOverlap({ db, ...base, prNumbers: [7, 8] });
    expect(result).toEqual({ skip: true, reason: "pr_merge_push" });
  });

  it("does NOT skip when at least one referenced PR has no job (mixed push)", async () => {
    const db = buildDb([[], [], [{ id: "pr-7" }], [], []]);
    const result = await findPushOverlap({ db, ...base, prNumbers: [7, 8] });
    expect(result).toEqual({ skip: false, reason: null });
  });

  it("does NOT skip a plain direct push (no release job, no PR numbers)", async () => {
    const db = buildDb([[], []]);
    const result = await findPushOverlap({ db, ...base, prNumbers: [] });
    expect(result).toEqual({ skip: false, reason: null });
  });

  it("skips a release already stored by history import", async () => {
    const db = buildDb([[], [{ id: "stored-release" }]]);
    const result = await findPushOverlap({ db, ...base, prNumbers: [] });
    expect(result).toEqual({ skip: true, reason: "release_push" });
  });

  it("skips PR merges already stored by history import", async () => {
    const db = buildDb([
      [],
      [],
      [],
      [],
      [{ id: "stored-pr-7" }],
      [{ id: "stored-pr-8" }],
    ]);
    const result = await findPushOverlap({ db, ...base, prNumbers: [7, 8] });
    expect(result).toEqual({ skip: true, reason: "pr_merge_push" });
  });
});
