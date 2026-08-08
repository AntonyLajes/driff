import { describe, expect, it, vi } from "vitest";

import { execute } from "@/changes/backfill-workspace.js";
import type { WorkspaceParityReport } from "@/changes/inspect-workspace-parity.js";
import type { Database } from "@/db/client.js";
import type { PushContext } from "@/sources/github/gather-push-context.js";
import type { PullRequestEvent } from "@/sources/source.js";

const orderedQuery = (rows: unknown[]) => {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  return { from };
};

const buildDb = (queries: unknown[]) => {
  const select = vi.fn();
  for (const query of queries) {
    select.mockReturnValueOnce(query);
  }
  return { db: { select } as unknown as Database, select };
};

const parity = (input?: {
  pullRequests?: string[];
  pushes?: string[];
  releases?: string[];
  complete?: boolean;
}): WorkspaceParityReport => {
  const source = (ids: string[]) => ({
    legacyCount: ids.length,
    projectedCount: 0,
    missingSourceRecordIds: ids,
    coveragePercent: ids.length === 0 ? 100 : 0,
  });
  return {
    workspaceId: "workspace-1",
    repo: "acme/app",
    complete: input?.complete ?? false,
    sources: {
      pullRequests: source(input?.pullRequests ?? []),
      pushes: source(input?.pushes ?? []),
      releases: source(input?.releases ?? []),
    },
    canonical: { versions: 0, versionedChanges: 0, unversionedChanges: 0 },
  };
};

const pullRequestRow = (overrides: Record<string, unknown> = {}) => ({
  id: "pr-1",
  repo: "acme/app",
  prNumber: 42,
  title: "feat: faster checkout",
  summaryUserFacing: "Checkout mais rápido.",
  summaryTechnical: "Simplifica o fluxo.",
  category: "feature",
  area: "Checkout",
  promptVersion: null,
  mergedAt: new Date("2026-08-01T12:00:00.000Z"),
  ...overrides,
});

const pushRow = {
  id: "push-1",
  repo: "acme/app",
  branch: "main",
  beforeSha: "a".repeat(40),
  afterSha: "b".repeat(40),
  pusher: "octocat",
  pushedAt: new Date("2026-08-02T12:00:00.000Z"),
  title: "Carrinho mais estável",
  summaryUserFacing: "Evita uma falha no carrinho.",
  summaryTechnical: "Valida o estado vazio.",
  category: "bugfix",
  area: null,
  promptVersion: 3,
};

const releaseRow = {
  id: "release-1",
  repo: "acme/app",
  versionKey: "2.0.0+10",
  previousVersionKey: "1.9.0+9",
  shortVersion: "2.0.0",
  buildVersion: "10",
  beforeSha: "b".repeat(40),
  headSha: "c".repeat(40),
  prNumbers: [42],
  changelog: "Checkout mais rápido e estável.",
  sections: {
    title: "Uma compra mais simples",
    sections: [{ label: "Novidades", items: ["Checkout mais rápido"] }],
  },
  promptVersion: 4,
  createdAt: new Date("2026-08-03T12:00:00.000Z"),
};

const fetchedPullRequest: PullRequestEvent = {
  repo: "acme/app",
  prNumber: 42,
  title: "feat: faster checkout",
  body: null,
  author: "octocat",
  mergedAt: new Date("2026-08-01T12:00:00.000Z"),
  headSha: "b".repeat(40),
  baseBranch: "main",
  diff: "diff",
  files: [{ path: "src/checkout.ts", additions: 10, deletions: 2 }],
};

const pushContext = (afterSha: string): PushContext => ({
  compareCommits: [{ sha: afterSha, message: "feat: change" }],
  commitMessages: ["feat: change"],
  prNumbers: [],
  totalCommits: 1,
  compareUrl: `https://github.com/acme/app/compare/base...${afterSha}`,
  fileChangeSummary: "modified: src/checkout.ts",
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  diff: "diff",
});

const dependencies = () => ({
  source: { fetchPullRequest: vi.fn(async () => fetchedPullRequest) },
  loadPushContext: vi.fn(async ({ afterSha }: { afterSha: string }) =>
    pushContext(afterSha),
  ),
  pullRequestProjector: { project: vi.fn(async () => undefined) },
  pushProjector: { project: vi.fn(async () => undefined) },
  releaseProjector: {
    project: vi.fn(async () => ({ versionId: "version-1", linkedChangeIds: [] })),
  },
});

describe("changes/backfill-workspace execute", () => {
  it("should plan a dry run without GitHub calls or database writes", async () => {
    const before = parity({
      pullRequests: ["pr-1", "pr-incomplete"],
      pushes: ["push-1"],
      releases: ["release-1"],
    });
    const inspectParity = vi.fn(async () => before);
    const db = buildDb([
      orderedQuery([
        pullRequestRow(),
        pullRequestRow({
          id: "pr-incomplete",
          summaryTechnical: null,
        }),
      ]),
      orderedQuery([pushRow]),
      orderedQuery([releaseRow]),
    ]);
    const deps = dependencies();

    const result = await execute({
      db: db.db,
      workspaceId: "workspace-1",
      repo: "acme/app",
      inspectParity,
      ...deps,
    });

    expect(result.mode).toBe("dry_run");
    expect(result.after).toBe(before);
    expect(result.sources).toEqual({
      pullRequests: {
        candidates: 2,
        ready: 1,
        projected: 0,
        skipped: [
          {
            sourceRecordId: "pr-incomplete",
            reason: "legacy_summary_incomplete",
          },
        ],
      },
      pushes: { candidates: 1, ready: 1, projected: 0, skipped: [] },
      releases: { candidates: 1, ready: 1, projected: 0, skipped: [] },
    });
    expect(deps.source.fetchPullRequest).not.toHaveBeenCalled();
    expect(deps.loadPushContext).not.toHaveBeenCalled();
    expect(deps.pullRequestProjector.project).not.toHaveBeenCalled();
    expect(deps.pushProjector.project).not.toHaveBeenCalled();
    expect(deps.releaseProjector.project).not.toHaveBeenCalled();
    expect(inspectParity).toHaveBeenCalledOnce();
  });

  it("should apply missing projections in PR, push, then release order", async () => {
    const before = parity({
      pullRequests: ["pr-1"],
      pushes: ["push-1"],
      releases: ["release-1"],
    });
    const after = parity({ complete: true });
    const inspectParity = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const db = buildDb([
      orderedQuery([pullRequestRow()]),
      orderedQuery([pushRow]),
      orderedQuery([releaseRow]),
    ]);
    const deps = dependencies();

    const result = await execute({
      db: db.db,
      workspaceId: "workspace-1",
      repo: "acme/app",
      apply: true,
      inspectParity,
      ...deps,
    });

    expect(result.mode).toBe("apply");
    expect(result.after).toBe(after);
    expect(result.sources.pullRequests.projected).toBe(1);
    expect(result.sources.pushes.projected).toBe(1);
    expect(result.sources.releases.projected).toBe(1);
    expect(deps.source.fetchPullRequest).toHaveBeenCalledWith("acme/app", 42);
    expect(deps.pullRequestProjector.project).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceRecordId: "pr-1",
        promptVersion: null,
        summary: expect.objectContaining({
          title: "feat: faster checkout",
          category: "feature",
        }),
      }),
    );
    expect(deps.pushProjector.project).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRecordId: "push-1", promptVersion: 3 }),
    );
    expect(deps.releaseProjector.project).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceReleaseId: "release-1",
        title: "Uma compra mais simples",
        sections: [
          { label: "Novidades", items: ["Checkout mais rápido"] },
        ],
        commitShas: ["c".repeat(40)],
      }),
    );
    expect(inspectParity).toHaveBeenCalledTimes(2);
    expect(deps.pullRequestProjector.project.mock.invocationCallOrder[0]).toBeLessThan(
      deps.pushProjector.project.mock.invocationCallOrder[0]!,
    );
    expect(deps.pushProjector.project.mock.invocationCallOrder[0]).toBeLessThan(
      deps.releaseProjector.project.mock.invocationCallOrder[0]!,
    );
  });

  it("should make an already complete apply run idempotent", async () => {
    const complete = parity({ complete: true });
    const inspectParity = vi.fn(async () => complete);
    const db = buildDb([]);
    const deps = dependencies();

    const result = await execute({
      db: db.db,
      workspaceId: "workspace-1",
      repo: "acme/app",
      apply: true,
      inspectParity,
      ...deps,
    });

    expect(result.before.complete).toBe(true);
    expect(result.after.complete).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
    expect(deps.source.fetchPullRequest).not.toHaveBeenCalled();
    expect(deps.loadPushContext).not.toHaveBeenCalled();
    expect(inspectParity).toHaveBeenCalledTimes(2);
  });
});
