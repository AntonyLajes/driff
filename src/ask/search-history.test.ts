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
      isBot: false,
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
    const fuelStops = change("15", "Estimate fuel stops on ride cards");
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

  it("should return the earliest cited feature for a natural first-feature question", async () => {
    const firstFeature = {
      ...change("15", "Estimate fuel stops on ride cards"),
      firstOccurredAt: "2026-06-06T12:00:00.000Z",
      lastOccurredAt: "2026-06-06T12:00:00.000Z",
    };
    const latestFeature = change(
      "16",
      "Improve touch feedback on Home quick action buttons",
    );
    const olderChore = {
      ...change("14", "Prepare the repository for release automation"),
      category: "chore",
      firstOccurredAt: "2026-05-01T12:00:00.000Z",
      lastOccurredAt: "2026-05-01T12:00:00.000Z",
    };
    const timelineReader = vi.fn(async () =>
      page([version("1.3.4", [latestFeature])], [firstFeature, olderChore]),
    );

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "Qual a primeira feature feita no app e por quem?",
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
            change: expect.objectContaining({ id: "15" }),
            version: null,
          }),
        ],
      }),
    );
  });

  it("should recover a cited change when the query contains a small typo", async () => {
    const buttonChange = change(
      "16",
      "Improve touch feedback on Home quick action buttons",
    );
    const unrelated = change("15", "Estimate fuel stops on ride cards");
    const timelineReader = vi.fn(async () =>
      page([], [unrelated, buttonChange]),
    );

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "buton",
      timelineReader,
    });

    expect(result.status).toBe("answered");
    expect(result.confidence).toBe("low");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.change.id).toBe("16");
  });

  it("should remove weak same-area matches from a focused question", async () => {
    const etaFix = {
      ...change("17", "Fix NaN ETA display for routes with no legs"),
      summaryExecutive:
        "Routes with no legs now show zero minutes instead of an invalid ETA.",
      summaryTechnical: "Returns 0 when the route legs collection is empty.",
      category: "bugfix",
      areas: [
        {
          id: "area-rides",
          name: "Rides",
          slug: "rides",
          confidence: 98,
          source: "ai",
        },
      ],
    };
    const paceFeature = {
      ...change("14", "Add ride pace classification"),
      areas: etaFix.areas,
    };
    const fuelFeature = {
      ...change("15", "Estimate fuel stops on ride cards"),
      areas: etaFix.areas,
    };
    const timelineReader = vi.fn(async () =>
      page([], [paceFeature, fuelFeature, etaFix]),
    );

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "Qual correção foi feita sobre o ETA zero e quem fez?",
      timelineReader,
    });

    expect(result.status).toBe("answered");
    expect(result.totalMatches).toBe(1);
    expect(result.matches).toEqual([
      expect.objectContaining({ change: expect.objectContaining({ id: "17" }) }),
    ]);
    expect(result.queryTerms).toEqual(
      expect.arrayContaining(["correcao", "bugfix", "fix", "eta", "zero", "0"]),
    );
  });

  it("should keep tied matches for a broad area query", async () => {
    const ridesArea = [
      {
        id: "area-rides",
        name: "Rides",
        slug: "rides",
        confidence: 98,
        source: "ai",
      },
    ];
    const timelineReader = vi.fn(async () =>
      page([], [
        { ...change("14", "Add ride pace classification"), areas: ridesArea },
        { ...change("15", "Estimate fuel stops"), areas: ridesArea },
      ]),
    );

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "O que mudou em rides?",
      timelineReader,
    });

    expect(result.status).toBe("answered");
    expect(result.totalMatches).toBe(2);
    expect(result.matches).toHaveLength(2);
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
      ...change("204", "Add idempotency keys to the payment creation endpoint"),
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

  it("should scope a team activity question to the current week", async () => {
    const currentWeek = {
      ...change("21", "Add saved searches to the projects page"),
      firstOccurredAt: "2026-08-07T12:00:00.000Z",
      lastOccurredAt: "2026-08-07T12:00:00.000Z",
    };
    const previousWeek = {
      ...change("20", "Add CSV export to reports"),
      firstOccurredAt: "2026-08-01T12:00:00.000Z",
      lastOccurredAt: "2026-08-01T12:00:00.000Z",
    };
    const timelineReader = vi.fn(async () =>
      page([], [previousWeek, currentWeek]),
    );

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "O que o time fez esta semana?",
      now: new Date("2026-08-08T20:00:00.000Z"),
      timelineReader,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "answered",
        confidence: "high",
        period: {
          kind: "this_week",
          startAt: "2026-08-03T00:00:00.000Z",
          endAt: "2026-08-08T20:00:00.000Z",
          days: null,
        },
        matches: [
          expect.objectContaining({
            change: expect.objectContaining({ id: "21" }),
          }),
        ],
      }),
    );
  });

  it("should combine a contributor with a rolling time period", async () => {
    const antonyChange = {
      ...change("22", "Improve workspace navigation"),
      contributors: [
        {
          externalIdentity: "github:antonylajes",
          displayName: "AntonyLajes",
          role: "pr_author",
          sourceUrl: "https://github.com/AntonyLajes",
          isBot: false,
        },
      ],
      firstOccurredAt: "2026-08-07T12:00:00.000Z",
      lastOccurredAt: "2026-08-07T12:00:00.000Z",
    };
    const marinaChange = {
      ...change("23", "Improve onboarding diagnostics"),
      contributors: [
        {
          externalIdentity: "github:marina-dev",
          displayName: "Marina Costa",
          role: "pr_author",
          sourceUrl: "https://github.com/marina-dev",
          isBot: false,
        },
      ],
      firstOccurredAt: "2026-08-06T12:00:00.000Z",
      lastOccurredAt: "2026-08-06T12:00:00.000Z",
    };
    const timelineReader = vi.fn(async () =>
      page([], [marinaChange, antonyChange]),
    );

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "O que Antony fez nos últimos 7 dias?",
      now: new Date("2026-08-08T20:00:00.000Z"),
      timelineReader,
    });

    expect(result.status).toBe("answered");
    expect(result.queryTerms).toEqual(["antony"]);
    expect(result.period).toEqual(
      expect.objectContaining({ kind: "last_days", days: 7 }),
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.change.id).toBe("22");
  });

  it("should filter an exact version by contributor", async () => {
    const antonyChange = change("24", "Improve project cards");
    const marinaChange = {
      ...change("25", "Add project search"),
      contributors: [
        {
          externalIdentity: "github:marina-dev",
          displayName: "Marina Costa",
          role: "pr_author",
          sourceUrl: "https://github.com/marina-dev",
          isBot: false,
        },
      ],
    };
    const timelineReader = vi.fn(async () =>
      page([version("1.4.0", [antonyChange, marinaChange])]),
    );

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "O que Marina fez na versão 1.4.0?",
      timelineReader,
    });

    expect(result.status).toBe("answered");
    expect(result.mode).toBe("version");
    expect(result.queryTerms).toEqual(["1.4.0", "marina"]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.change.id).toBe("25");
  });

  it("should disclose when a team answer has more cited matches", async () => {
    const changes = Array.from({ length: 6 }, (_, index) => ({
      ...change(String(30 + index), `Team change ${index + 1}`),
      firstOccurredAt: `2026-08-0${index + 3}T12:00:00.000Z`,
      lastOccurredAt: `2026-08-0${index + 3}T12:00:00.000Z`,
    }));
    const timelineReader = vi.fn(async () => page([], changes));

    const result = await execute({
      db: {} as never,
      workspaceId: WORKSPACE_ID,
      question: "What did the team ship this week?",
      now: new Date("2026-08-08T20:00:00.000Z"),
      timelineReader,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "answered",
        totalMatches: 6,
        hasMore: true,
      }),
    );
    expect(result.matches).toHaveLength(5);
  });
});
