import type { FastifyInstance } from "fastify";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { verifySessionJwt } from "@/auth/session-jwt.js";
import type { Database } from "@/db/client.js";
import { pullRequestsTable, pushesTable, releasesTable, workspacesTable } from "@/db/schema.js";
import { reviewTimeSavedMinutes } from "@/lib/review-time.js";

export interface MeStatsRegistrationInput {
  db: Database;
  jwtSecret: string;
}

const readBearerToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

const WEEK_MS = 7 * 86_400_000;
const WEEKS_SHOWN = 8;

/** Monday 00:00 UTC of the week containing `time` — mirrors date_trunc('week'). */
const weekStartMs = (time: number): number => {
  const date = new Date(time);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime() - day * 86_400_000;
};

interface RepoAggregate {
  total: number;
  week: number;
}

/**
 * Cross-workspace productivity aggregates for the Home and Metrics screens.
 * Counts and review-time-saved only — cost/token figures are never exposed.
 */
export const handler = async (
  instance: FastifyInstance,
  input: MeStatsRegistrationInput,
): Promise<void> => {
  const loadLinkedWorkspaces = async (userId: string) => {
    const workspaces = await input.db
      .select({
        id: workspacesTable.id,
        name: workspacesTable.name,
        slug: workspacesTable.slug,
        repoFullName: workspacesTable.repoFullName,
      })
      .from(workspacesTable)
      .where(eq(workspacesTable.userId, userId));
    const repos = [
      ...new Set(
        workspaces
          .map((workspace) => workspace.repoFullName?.trim() ?? "")
          .filter((repo) => repo.length > 0),
      ),
    ];
    return { workspaces, repos };
  };

  instance.get("/api/me/stats", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const { workspaces, repos } = await loadLinkedWorkspaces(session.userId);

    const currentWeekStart = weekStartMs(Date.now());
    const emptyWeekly = Array.from({ length: WEEKS_SHOWN }, (_, index) => ({
      weekStart: new Date(
        currentWeekStart - (WEEKS_SHOWN - 1 - index) * WEEK_MS,
      ).toISOString(),
      count: 0,
    }));

    const zeroProject = (workspace: (typeof workspaces)[number]) => ({
      workspaceId: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      summaries: 0,
      prs: 0,
      pushes: 0,
      versions: 0,
      summariesThisWeek: 0,
      reviewTimeSavedMinutes: 0,
    });

    if (repos.length === 0) {
      return reply.send({
        stats: {
          summaries: 0,
          prs: 0,
          pushes: 0,
          versions: 0,
          reviewTimeSavedMinutes: 0,
          weekDeltas: {
            summaries: 0,
            prs: 0,
            pushes: 0,
            versions: 0,
            reviewTimeSavedMinutes: 0,
          },
        },
        weekly: emptyWeekly,
        projects: workspaces.map(zeroProject),
      });
    }

    // postgres.js can't bind a Date inside a raw sql fragment — pass ISO text.
    const weekAgoIso = new Date(Date.now() - WEEK_MS).toISOString();
    const weekFilter = (column: AnyPgColumn) =>
      sql<number>`count(*) filter (where ${column} >= ${weekAgoIso})`.mapWith(Number);

    // Query order matters for the test mocks: grouped pr → push → version,
    // then weekly pr → push → version.
    const prRows = await input.db
      .select({
        repo: pullRequestsTable.repo,
        total: count(),
        week: weekFilter(pullRequestsTable.mergedAt),
      })
      .from(pullRequestsTable)
      .where(inArray(pullRequestsTable.repo, repos))
      .groupBy(pullRequestsTable.repo);
    const pushRows = await input.db
      .select({
        repo: pushesTable.repo,
        total: count(),
        week: weekFilter(pushesTable.pushedAt),
      })
      .from(pushesTable)
      .where(inArray(pushesTable.repo, repos))
      .groupBy(pushesTable.repo);
    const versionRows = await input.db
      .select({
        repo: releasesTable.repo,
        total: count(),
        week: weekFilter(releasesTable.createdAt),
      })
      .from(releasesTable)
      .where(inArray(releasesTable.repo, repos))
      .groupBy(releasesTable.repo);

    const toMap = (rows: Array<{ repo: string } & RepoAggregate>) =>
      new Map(rows.map((row) => [row.repo, { total: row.total, week: row.week }]));
    const prByRepo = toMap(prRows);
    const pushByRepo = toMap(pushRows);
    const versionByRepo = toMap(versionRows);

    const sumBy = (map: Map<string, RepoAggregate>, key: keyof RepoAggregate) =>
      [...map.values()].reduce((acc, value) => acc + value[key], 0);
    const prs = sumBy(prByRepo, "total");
    const pushes = sumBy(pushByRepo, "total");
    const versions = sumBy(versionByRepo, "total");
    const weekPrs = sumBy(prByRepo, "week");
    const weekPushes = sumBy(pushByRepo, "week");
    const weekVersions = sumBy(versionByRepo, "week");

    const bucketsSince = new Date(currentWeekStart - (WEEKS_SHOWN - 1) * WEEK_MS);
    const weeklyOf = async (
      table: typeof pullRequestsTable | typeof pushesTable | typeof releasesTable,
      column: AnyPgColumn,
    ) =>
      input.db
        .select({
          week: sql<Date>`date_trunc('week', ${column})`,
          value: count(),
        })
        .from(table)
        .where(and(inArray(table.repo, repos), gte(column, bucketsSince)))
        .groupBy(sql`date_trunc('week', ${column})`);
    const weeklyRows = [
      ...(await weeklyOf(pullRequestsTable, pullRequestsTable.mergedAt)),
      ...(await weeklyOf(pushesTable, pushesTable.pushedAt)),
      ...(await weeklyOf(releasesTable, releasesTable.createdAt)),
    ];

    const weeklyCounts = new Map<number, number>();
    for (const row of weeklyRows) {
      const start = new Date(row.week).getTime();
      weeklyCounts.set(start, (weeklyCounts.get(start) ?? 0) + row.value);
    }
    const weekly = emptyWeekly.map((bucket) => ({
      weekStart: bucket.weekStart,
      count: weeklyCounts.get(new Date(bucket.weekStart).getTime()) ?? 0,
    }));

    const projects = workspaces.map((workspace) => {
      const repo = workspace.repoFullName?.trim() ?? "";
      if (repo.length === 0) {
        return zeroProject(workspace);
      }
      const pr = prByRepo.get(repo) ?? { total: 0, week: 0 };
      const push = pushByRepo.get(repo) ?? { total: 0, week: 0 };
      const version = versionByRepo.get(repo) ?? { total: 0, week: 0 };
      return {
        workspaceId: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        summaries: pr.total + push.total + version.total,
        prs: pr.total,
        pushes: push.total,
        versions: version.total,
        summariesThisWeek: pr.week + push.week + version.week,
        reviewTimeSavedMinutes: reviewTimeSavedMinutes(pr.total, push.total),
      };
    });

    return reply.send({
      stats: {
        summaries: prs + pushes + versions,
        prs,
        pushes,
        versions,
        reviewTimeSavedMinutes: reviewTimeSavedMinutes(prs, pushes),
        weekDeltas: {
          summaries: weekPrs + weekPushes + weekVersions,
          prs: weekPrs,
          pushes: weekPushes,
          versions: weekVersions,
          reviewTimeSavedMinutes: reviewTimeSavedMinutes(weekPrs, weekPushes),
        },
      },
      weekly,
      projects,
    });
  });

  instance.get("/api/me/activity", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.status(401).send({ error: "missing_or_invalid_authorization" });
    }
    const session = verifySessionJwt(token, input.jwtSecret);
    if (session === null) {
      return reply.status(401).send({ error: "invalid_session" });
    }

    const query = request.query as { limit?: string };
    const limitRaw = Number(query.limit ?? "10");
    const limit = Number.isInteger(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 50)
      : 10;

    const { workspaces, repos } = await loadLinkedWorkspaces(session.userId);
    if (repos.length === 0) {
      return reply.send({ items: [] });
    }

    const workspaceByRepo = new Map(
      workspaces
        .filter((workspace) => (workspace.repoFullName?.trim() ?? "").length > 0)
        .map((workspace) => [workspace.repoFullName!.trim(), workspace]),
    );

    interface ActivityItem {
      id: string;
      type: "pr" | "push" | "version";
      title: string;
      timestamp: Date;
      workspaceName: string;
      workspaceSlug: string;
    }
    const items: ActivityItem[] = [];
    const pushItem = (
      repo: string,
      item: Omit<ActivityItem, "workspaceName" | "workspaceSlug">,
    ) => {
      const workspace = workspaceByRepo.get(repo);
      if (workspace === undefined) return;
      items.push({
        ...item,
        workspaceName: workspace.name,
        workspaceSlug: workspace.slug,
      });
    };

    // Query order matters for the test mocks: pr → push → version.
    const prRows = await input.db
      .select({
        id: pullRequestsTable.id,
        repo: pullRequestsTable.repo,
        prNumber: pullRequestsTable.prNumber,
        title: pullRequestsTable.title,
        mergedAt: pullRequestsTable.mergedAt,
      })
      .from(pullRequestsTable)
      .where(inArray(pullRequestsTable.repo, repos))
      .orderBy(desc(pullRequestsTable.mergedAt))
      .limit(limit);
    for (const row of prRows) {
      pushItem(row.repo, {
        id: row.id,
        type: "pr",
        title: `PR #${row.prNumber} — ${row.title}`,
        timestamp: row.mergedAt,
      });
    }

    const pushRows = await input.db
      .select({
        id: pushesTable.id,
        repo: pushesTable.repo,
        title: pushesTable.title,
        pushedAt: pushesTable.pushedAt,
      })
      .from(pushesTable)
      .where(inArray(pushesTable.repo, repos))
      .orderBy(desc(pushesTable.pushedAt))
      .limit(limit);
    for (const row of pushRows) {
      pushItem(row.repo, {
        id: row.id,
        type: "push",
        title: row.title,
        timestamp: row.pushedAt,
      });
    }

    const versionRows = await input.db
      .select({
        id: releasesTable.id,
        repo: releasesTable.repo,
        shortVersion: releasesTable.shortVersion,
        buildVersion: releasesTable.buildVersion,
        createdAt: releasesTable.createdAt,
      })
      .from(releasesTable)
      .where(inArray(releasesTable.repo, repos))
      .orderBy(desc(releasesTable.createdAt))
      .limit(limit);
    for (const row of versionRows) {
      pushItem(row.repo, {
        id: row.id,
        type: "version",
        title: `v${row.shortVersion} (${row.buildVersion})`,
        timestamp: row.createdAt,
      });
    }

    items.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return reply.send({
      items: items.slice(0, limit).map((item) => ({
        ...item,
        timestamp: item.timestamp.toISOString(),
      })),
    });
  });
};
