import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

import { execute as loadEnv } from "@/config/env.js";
import type { Destination } from "@/destinations/destination.js";
import type { Database } from "@/db/client.js";
import { pullRequestsTable, releasesTable } from "@/db/schema.js";
import type { ReleaseSummarizer } from "@/llm/release-summarizer.js";
import { execute as buildStandaloneHints } from "@/lib/release-commit-hints.js";
import { execute as resolveReleaseCompareBefore } from "@/jobs/resolve-release-compare-before.js";
import { execute as gatherReleaseContext } from "@/sources/github/gather-release-context.js";

export interface ProcessReleaseJobPayload {
  repo: string;
  beforeSha: string;
  afterSha: string;
  branch: string;
}

export interface ExecuteInput {
  db: Database;
  appId: string;
  privateKey: string;
  releaseSummarizer: ReleaseSummarizer;
  destination: Destination;
  infoPlistPath: string;
  projectPbxprojPath: string | null;
  promptVersion: number;
}

const parsePayload = (payload: Record<string, unknown>): ProcessReleaseJobPayload => {
  const repo = payload.repo;
  const beforeSha = payload.beforeSha;
  const afterSha = payload.afterSha;
  const branch = payload.branch;
  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error("Invalid process_release payload: repo must be a non-empty string.");
  }
  if (typeof beforeSha !== "string" || beforeSha.length === 0) {
    throw new Error("Invalid process_release payload: beforeSha must be a non-empty string.");
  }
  if (typeof afterSha !== "string" || afterSha.length === 0) {
    throw new Error("Invalid process_release payload: afterSha must be a non-empty string.");
  }
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error("Invalid process_release payload: branch must be a non-empty string.");
  }
  return { repo, beforeSha, afterSha, branch };
};

const isNullSha = (sha: string): boolean => {
  return /^0+$/.test(sha.trim());
};

/** Números de PR únicos no intervalo da release (ordem ordenada estável para query e texto). */
export const normalizeReleasePrNumbers = (prNumbers: number[]): number[] => {
  return [...new Set(prNumbers)].sort((a, b) => a - b);
};

export const execute = (input: ExecuteInput) => {
  return {
    execute: async (payload: Record<string, unknown>): Promise<void> => {
      const job = parsePayload(payload);
      const env = loadEnv();
      if (!env.NOTION_RELEASES_DATABASE_ID) {
        throw new Error("Release notes are not configured (NOTION_RELEASES_DATABASE_ID).");
      }

      const narrow = await gatherReleaseContext({
        appId: input.appId,
        privateKey: input.privateKey,
        repo: job.repo,
        beforeSha: job.beforeSha,
        afterSha: job.afterSha,
        infoPlistPath: input.infoPlistPath,
        projectPbxprojPath: input.projectPbxprojPath,
      });

      if (
        narrow.previousVersionKey !== null &&
        narrow.previousVersionKey === narrow.newVersionKey
      ) {
        return;
      }

      const compareBeforeResolved = await resolveReleaseCompareBefore({
        db: input.db,
        repo: job.repo,
        branch: job.branch,
        beforeVersion: narrow.beforeVersion,
        afterVersion: narrow.afterVersion,
        webhookBeforeSha: job.beforeSha,
        releaseCompareRootSha: env.RELEASE_COMPARE_ROOT_SHA ?? null,
      });

      const webhookBeforeTrim = job.beforeSha.trim();
      const afterTrim = job.afterSha.trim();
      let effectiveCompareBefore = compareBeforeResolved.trim();
      if (isNullSha(effectiveCompareBefore) || effectiveCompareBefore === afterTrim) {
        effectiveCompareBefore = webhookBeforeTrim;
      }

      const context =
        effectiveCompareBefore === webhookBeforeTrim
          ? narrow
          : await gatherReleaseContext({
              appId: input.appId,
              privateKey: input.privateKey,
              repo: job.repo,
              beforeSha: job.beforeSha,
              afterSha: job.afterSha,
              compareBeforeSha: effectiveCompareBefore,
              infoPlistPath: input.infoPlistPath,
              projectPbxprojPath: input.projectPbxprojPath,
            });

      const existing = await input.db
        .select({ id: releasesTable.id })
        .from(releasesTable)
        .where(
          and(
            eq(releasesTable.repo, job.repo),
            eq(releasesTable.versionKey, context.newVersionKey),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        return;
      }

      const releasePrNumbers = normalizeReleasePrNumbers(context.prNumbers);
      const summarizerContext =
        releasePrNumbers.length === context.prNumbers.length
          ? context
          : { ...context, prNumbers: releasePrNumbers };

      let prContributions: Array<{
        prNumber: number;
        summaryUserFacing: string | null;
        category: string | null;
        title: string | null;
      }> = [];
      if (releasePrNumbers.length > 0) {
        const rows = await input.db
          .select({
            prNumber: pullRequestsTable.prNumber,
            summaryUserFacing: pullRequestsTable.summaryUserFacing,
            category: pullRequestsTable.category,
            title: pullRequestsTable.title,
          })
          .from(pullRequestsTable)
          .where(
            and(
              eq(pullRequestsTable.repo, job.repo),
              inArray(pullRequestsTable.prNumber, releasePrNumbers),
            ),
          );
        const byNum = new Map(rows.map((r) => [r.prNumber, r]));
        prContributions = releasePrNumbers.map((n) => {
          const row = byNum.get(n);
          return {
            prNumber: n,
            summaryUserFacing: row?.summaryUserFacing ?? null,
            category: row?.category ?? null,
            title: row?.title ?? null,
          };
        });
      }

      const standaloneCommitHints = buildStandaloneHints(context.compareCommits);

      const notes = await input.releaseSummarizer.summarizeRelease({
        context: summarizerContext,
        repo: job.repo,
        branch: job.branch,
        prContributions,
        standaloneCommitHints,
      });
      const publish = await input.destination.publishRelease({
        title: notes.title,
        repo: job.repo,
        branch: job.branch,
        newVersionKey: context.newVersionKey,
        previousVersionKey: context.previousVersionKey,
        shortVersion: context.afterVersion.short,
        buildVersion: context.afterVersion.build,
        compareUrl: context.compareUrl,
        prNumbers: releasePrNumbers,
        changelog: notes.changelog,
        sections: notes.sections,
      });

      const priorEraRow = await input.db
        .select({ marketingEraStartSha: releasesTable.marketingEraStartSha })
        .from(releasesTable)
        .where(
          and(
            eq(releasesTable.repo, job.repo),
            eq(releasesTable.branch, job.branch),
            eq(releasesTable.shortVersion, context.afterVersion.short),
            isNotNull(releasesTable.marketingEraStartSha),
          ),
        )
        .orderBy(asc(releasesTable.createdAt))
        .limit(1);

      const existingEraSha = priorEraRow[0]?.marketingEraStartSha?.trim();
      const marketingEraStartSha =
        existingEraSha && existingEraSha.length > 0 ? existingEraSha : effectiveCompareBefore;

      await input.db.insert(releasesTable).values({
        repo: job.repo,
        versionKey: context.newVersionKey,
        shortVersion: context.afterVersion.short,
        buildVersion: context.afterVersion.build,
        previousVersionKey: context.previousVersionKey,
        branch: job.branch,
        headSha: job.afterSha,
        beforeSha: effectiveCompareBefore,
        prNumbers: releasePrNumbers,
        changelog: notes.changelog,
        sections: { sections: notes.sections, title: notes.title } as unknown as Record<
          string,
          unknown
        >,
        notionPageId: publish.pageId,
        promptVersion: input.promptVersion,
        marketingEraStartSha,
        updatedAt: new Date(),
      });
    },
  };
};

/** Para testes: critério de “há uma nova versão lógica” a partir de chaves normalizadas. */
export const hasVersionKeyChanged = (context: {
  previousVersionKey: string | null;
  newVersionKey: string;
}): boolean => {
  if (context.previousVersionKey === null) {
    return true;
  }
  return context.previousVersionKey !== context.newVersionKey;
};
