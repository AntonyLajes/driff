import { describe, expect, it, vi } from "vitest";

import { execute } from "@/ask/search-history.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000aa";

const evidence = (externalId: string, url: string | null) => ({
  id: `evidence-${externalId}`,
  kind: "pull_request",
  sourceKey: `github:acme/app:pull_request:${externalId}`,
  externalId,
  url,
  sha: "a".repeat(40),
  path: null,
  occurredAt: "2026-08-08T12:00:00.000Z",
  metadata: { baseBranch: "main" },
});

const change = (
  id: string,
  title: string,
  evidenceUrl: string | null = `https://github.com/acme/app/pull/${id}`,
) => ({
  id,
  title,
  summaryExecutive: "The Home screen is easier to use.",
  summaryTechnical: "Adds Android ripple feedback and a larger hit area.",
  category: "feature",
  confidence: 95,
  firstOccurredAt: "2026-08-08T12:00:00.000Z",
  lastOccurredAt: "2026-08-08T12:00:00.000Z",
  areas: [
    {
      id: "area-home",
      name: "Home",
      slug: "home",
      confidence: 90,
      source: "ai",
    },
  ],
  contributors: [
    {
      externalIdentity: "github:octocat",
      displayName: "Octocat",
      role: "pr_author",
      sourceUrl: "https://github.com/octocat",
    },
  ],
  evidence: [evidence(id, evidenceUrl)],
});

const version = (
  displayVersion: string,
  changes: ReturnType<typeof change>[],
) => ({
  id: `version-${displayVersion}`,
  displayVersion,
  normalizedVersion: `${displayVersion}+6`,
  buildVersion: "6",
  title: `Version ${displayVersion}`,
  changelog: "Improves the Home experience.",
  sections: [],
  sourceUrl: `https://github.com/acme/app/compare/${displayVersion}`,
  previousVersionId: null,
  beforeSha: "a".repeat(40),
  headSha: "b".repeat(40),
  releasedAt: "2026-08-08T13:00:00.000Z",
  changes,
});

const page = (
  versions: ReturnType<typeof version>[],
  inDevelopment: ReturnType<typeof change>[] = [],
) => ({
  versions,
  inDevelopment: { changes: inDevelopment, hasMore: false },
  pageInfo: { hasNextPage: false, nextCursor: null },
});

describe("ask/search-history execute", () => {
  it("should answer a version question with cited canonical changes", async () => {
    const releaseChange = change(
      "16",
      "Improve touch feedback on Home quick action buttons",
    );
    const timelineReader = vi.fn(async () =>
      page([version("1.3.4", [releaseChange])]),
    );

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "O que mudou na versão 1.3.4?",
      timelineReader,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "answered",
        mode: "version",
        confidence: "high",
        version: expect.objectContaining({ displayVersion: "1.3.4" }),
        matches: [
          expect.objectContaining({
            score: 100,
            change: expect.objectContaining({ id: "16" }),
          }),
        ],
      }),
    );
  });

  it("should expand Portuguese terms and rank a cited change", async () => {
    const quickActions = change(
      "16",
      "Improve touch feedback on Home quick action buttons",
    );
    const fuelStops = change(
      "15",
      "Estimate fuel stops on ride cards",
    );
    const timelineReader = vi.fn(async () =>
      page([], [fuelStops, quickActions]),
    );

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "Quando alteramos os botões de ação rápida na tela inicial?",
      timelineReader,
    });

    expect(result.status).toBe("answered");
    expect(result.mode).toBe("change");
    expect(result.matches[0]).toEqual(
      expect.objectContaining({
        change: expect.objectContaining({ id: "16" }),
        version: null,
      }),
    );
    expect(result.queryTerms).toEqual(
      expect.arrayContaining(["buttons", "action", "quick", "screen", "home"]),
    );
  });

  it("should return the most recent cited feature for a natural latest-feature question", async () => {
    const olderFeature = {
      ...change("15", "Estimate fuel stops on ride cards"),
      firstOccurredAt: "2026-06-06T12:00:00.000Z",
      lastOccurredAt: "2026-06-06T12:00:00.000Z",
    };
    const latestFeature = change(
      "16",
      "Improve touch feedback on Home quick action buttons",
    );
    const newerBugfix = {
      ...change("17", "Fix a crash when opening offline maps"),
      category: "bugfix",
      firstOccurredAt: "2026-08-09T12:00:00.000Z",
      lastOccurredAt: "2026-08-09T12:00:00.000Z",
    };
    const timelineReader = vi.fn(async () =>
      page([version("1.3.4", [latestFeature])], [olderFeature, newerBugfix]),
    );

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "Qual a ultima feature feita no app e por quem?",
      timelineReader,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "answered",
        mode: "change",
        confidence: "high",
        matches: [
          expect.objectContaining({
            score: 100,
            change: expect.objectContaining({ id: "16" }),
            version: expect.objectContaining({ displayVersion: "1.3.4" }),
          }),
        ],
      }),
    );
  });

  it("should refuse to answer when matching history has no linked evidence", async () => {
    const timelineReader = vi.fn(async () =>
      page([], [change("17", "Improve checkout button", null)]),
    );

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "checkout button",
      timelineReader,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "no_evidence",
        confidence: "none",
        matches: [],
      }),
    );
  });

  it("should ignore short stop words instead of returning an unrelated cited change", async () => {
    const apiChange = {
      ...change(
        "204",
        "Add idempotency keys to the payment creation endpoint",
      ),
      summaryExecutive:
        "Clients can retry payment creation without duplicate charges.",
      summaryTechnical:
        "Stores idempotency keys and replays repeated payment requests.",
      areas: [
        {
          id: "area-payments",
          name: "Payments API",
          slug: "payments-api",
          confidence: 98,
          source: "ai",
        },
      ],
    };
    const timelineReader = vi.fn(async () => page([], [apiChange]));

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "Who added dark mode to the dashboard?",
      timelineReader,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "no_evidence",
        confidence: "none",
        queryTerms: ["dark", "mode", "dashboard"],
        matches: [],
      }),
    );
  });
});
