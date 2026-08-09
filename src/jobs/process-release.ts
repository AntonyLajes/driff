import { and, asc, desc, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import type { ReleaseProjector } from "@/changes/project-release.js";
import type { SummaryLanguage } from "@/config/summary-language.js";
import type { Destination } from "@/destinations/destination.js";
import { publishBestEffort } from "@/destinations/optional-destination.js";
import type { Database } from "@/db/client.js";
import { projectVersionsTable, pullRequestsTable, releasesTable } from "@/db/schema.js";
import type { ReleaseSummarizer } from "@/llm/release-summarizer.js";
import { recordLlmUsage } from "@/llm/usage.js";
import { execute as buildStandaloneHints } from "@/lib/release-commit-hints.js";
import { execute as resolveReleaseCompareBefore } from "@/jobs/resolve-release-compare-before.js";
import type { ReleaseProjectKind } from "@/config/release-project-kind.js";
import { execute as gatherReleaseContext } from "@/sources/github/gather-release-context.js";
import { filterHistoryFileSummary } from "@/config/history-content-filter.js";
import type { ReleaseVersionStrategy } from "@/config/release-version-strategy.js";
import { parseSemverTag } from "@/lib/semver-tag.js";
import {
  getInstallationOctokit,
  type OctokitLike,
} from "@/sources/github/github-installation.js";
import { z } from "zod";

export interface ProcessReleaseJobPayload {
  repo: string;
  beforeSha: string;
  afterSha: string;
  branch: string;
  releasedAt: Date;
  force: boolean;
  tagName: string | null;
  sourceUrl: string | null;
}

export interface ExecuteInput {
  db: Database;
  appId: string;
  privateKey: string;
  releaseSummarizer: ReleaseSummarizer;
  destination: Destination;
  infoPlistPath: string;
  projectPbxprojPath: string | null;
  /** Expo / RN app config path; when set, version is read from this file (see `expo-app-config-version`). */
  expoAppConfigPath: string | null;
  releaseProjectKind?: ReleaseProjectKind | null;
  releaseVersionFilePath?: string | null;
  releaseVersionStrategy?: ReleaseVersionStrategy;
  octokitFactory?: (auth: string) => OctokitLike;
  promptVersion: number;
  summaryLanguage?: SummaryLanguage;
  releaseCompareRootSha: string | null;
  canonicalProjection?: {
    projector: ReleaseProjector;
    workspaceId: string;
  };
  contentFilter?: {
    excludedPaths: readonly string[];
  };
}

const parsePayload = (
  payload: Record<string, unknown>,
): ProcessReleaseJobPayload => {
  const repo = payload.repo;
  const beforeSha = payload.beforeSha;
  const afterSha = payload.afterSha;
  const branch = payload.branch;
  const releasedAt = payload.releasedAt;
  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error(
      "Invalid process_release payload: repo must be a non-empty string.",
    );
  }
  if (typeof beforeSha !== "string" || beforeSha.length === 0) {
    throw new Error(
      "Invalid process_release payload: beforeSha must be a non-empty string.",
    );
  }
  if (typeof afterSha !== "string" || afterSha.length === 0) {
    throw new Error(
      "Invalid process_release payload: afterSha must be a non-empty string.",
    );
  }
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error(
      "Invalid process_release payload: branch must be a non-empty string.",
    );
  }
  let releasedAtValue = new Date();
  if (typeof releasedAt === "string" && releasedAt.length > 0) {
    const parsed = new Date(releasedAt);
    if (!Number.isNaN(parsed.getTime())) {
      releasedAtValue = parsed;
    }
  } else if (
    releasedAt instanceof Date &&
    !Number.isNaN(releasedAt.getTime())
  ) {
    releasedAtValue = releasedAt;
  }
  return {
    repo,
    beforeSha,
    afterSha,
    branch,
    releasedAt: releasedAtValue,
    force: payload.force === true,
    tagName: typeof payload.tagName === "string" && payload.tagName.trim() ? payload.tagName.trim() : null,
    sourceUrl: typeof payload.sourceUrl === "string" && payload.sourceUrl.trim() ? payload.sourceUrl.trim() : null,
  };
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
      const strategy = input.releaseVersionStrategy ?? "version_file";

      let processingBeforeSha = job.beforeSha;
      let processingAfterSha = job.afterSha;
      let previousSourceRef: string | null | undefined;
      let versionOverride:
        | {
            beforeVersion: { short: string; build: string } | null;
            afterVersion: { short: string; build: string };
          }
        | undefined;

      if (strategy !== "version_file") {
        const parsedTag = parseSemverTag(job.tagName);
        if (parsedTag === null) {
          throw new Error(
            `${strategy} releases require a valid SemVer tag (for example v1.2.3).`,
          );
        }

        const { octokit, owner, repo } = await getInstallationOctokit({
          appId: input.appId,
          privateKey: input.privateKey,
          repo: job.repo,
          octokitFactory: input.octokitFactory,
        });
        const commitResponse = await octokit.request<unknown>(
          "GET /repos/{owner}/{repo}/commits/{ref}",
          { owner, repo, ref: parsedTag.tagName },
        );
        const tagCommit = z
          .object({
            sha: z.string().min(1),
            parents: z.array(z.object({ sha: z.string().min(1) })),
          })
          .parse(commitResponse.data);
        processingAfterSha = tagCommit.sha;

        const previousRows =
          input.canonicalProjection === undefined
            ? []
            : await input.db
                .select({
                  sourceRef: projectVersionsTable.sourceRef,
                  displayVersion: projectVersionsTable.displayVersion,
                  buildVersion: projectVersionsTable.buildVersion,
                  headSha: projectVersionsTable.headSha,
                })
                .from(projectVersionsTable)
                .where(
                  and(
                    eq(
                      projectVersionsTable.workspaceId,
                      input.canonicalProjection.workspaceId,
                    ),
                    eq(projectVersionsTable.strategy, strategy),
                    ne(projectVersionsTable.sourceRef, parsedTag.tagName),
                    isNotNull(projectVersionsTable.releasedAt),
                    lt(projectVersionsTable.releasedAt, job.releasedAt),
                  ),
                )
                .orderBy(desc(projectVersionsTable.releasedAt))
                .limit(1);
        const previous = previousRows[0];
        processingBeforeSha =
          previous?.headSha?.trim() || tagCommit.parents[0]?.sha || job.beforeSha;
        previousSourceRef = previous?.sourceRef ?? null;
        versionOverride = {
          beforeVersion:
            previous === undefined
              ? null
              : {
                  short: previous.displayVersion,
                  build: previous.buildVersion ?? "",
                },
          afterVersion: parsedTag.version,
        };
      }

      const narrow = await gatherReleaseContext({
        appId: input.appId,
        privateKey: input.privateKey,
        repo: job.repo,
        beforeSha: processingBeforeSha,
        afterSha: processingAfterSha,
        infoPlistPath: input.infoPlistPath,
        projectPbxprojPath: input.projectPbxprojPath,
        expoAppConfigPath: input.expoAppConfigPath,
        releaseProjectKind: input.releaseProjectKind,
        releaseVersionFilePath: input.releaseVersionFilePath,
        versionOverride,
        octokitFactory: input.octokitFactory,
      });

      if (
        narrow.previousVersionKey !== null &&
        narrow.previousVersionKey === narrow.newVersionKey
      ) {
        return;
      }

      const compareBeforeResolved =
        strategy === "version_file"
          ? await resolveReleaseCompareBefore({
              db: input.db,
              repo: job.repo,
              branch: job.branch,
              beforeVersion: narrow.beforeVersion,
              afterVersion: narrow.afterVersion,
              webhookBeforeSha: job.beforeSha,
              releaseCompareRootSha: input.releaseCompareRootSha,
            })
          : processingBeforeSha;

      const webhookBeforeTrim = processingBeforeSha.trim();
      const afterTrim = processingAfterSha.trim();
      let effectiveCompareBefore = compareBeforeResolved.trim();
      if (
        isNullSha(effectiveCompareBefore) ||
        effectiveCompareBefore === afterTrim
      ) {
        effectiveCompareBefore = webhookBeforeTrim;
      }

      const context =
        effectiveCompareBefore === webhookBeforeTrim
          ? narrow
          : await gatherReleaseContext({
              appId: input.appId,
              privateKey: input.privateKey,
              repo: job.repo,
              beforeSha: processingBeforeSha,
              afterSha: processingAfterSha,
              compareBeforeSha: effectiveCompareBefore,
              infoPlistPath: input.infoPlistPath,
              projectPbxprojPath: input.projectPbxprojPath,
              expoAppConfigPath: input.expoAppConfigPath,
              releaseProjectKind: input.releaseProjectKind,
              releaseVersionFilePath: input.releaseVersionFilePath,
              versionOverride,
              octokitFactory: input.octokitFactory,
            });

      const existing = await input.db
        .select({
          id: releasesTable.id,
          changelog: releasesTable.changelog,
          sections: releasesTable.sections,
          promptVersion: releasesTable.promptVersion,
          createdAt: releasesTable.createdAt,
        })
        .from(releasesTable)
        .where(
          and(
            eq(releasesTable.repo, job.repo),
            eq(releasesTable.versionKey, context.newVersionKey),
          ),
        )
        .limit(1);
      if (existing.length > 0 && !job.force) {
        const existingRelease = existing[0];
        if (
          existingRelease !== undefined &&
          input.canonicalProjection !== undefined
        ) {
          const sourceRef = job.tagName ?? context.newVersionKey;
          const projected = await input.db
            .select({ id: projectVersionsTable.id })
            .from(projectVersionsTable)
            .where(
              and(
                eq(
                  projectVersionsTable.workspaceId,
                  input.canonicalProjection.workspaceId,
                ),
                eq(projectVersionsTable.strategy, strategy),
                eq(projectVersionsTable.sourceRef, sourceRef),
              ),
            )
            .limit(1);
          if (projected.length === 0) {
            const storedNotes = z
              .object({
                title: z.string().optional(),
                sections: z
                  .array(
                    z.object({
                      label: z.string(),
                      items: z.array(z.string()),
                    }),
                  )
                  .optional(),
              })
              .safeParse(existingRelease.sections);
            await input.canonicalProjection.projector.project({
              workspaceId: input.canonicalProjection.workspaceId,
              sourceReleaseId: existingRelease.id,
              repo: job.repo,
              versionKey: context.newVersionKey,
              previousVersionKey: context.previousVersionKey,
              shortVersion: context.afterVersion.short,
              buildVersion: context.afterVersion.build,
              title:
                storedNotes.success && storedNotes.data.title
                  ? storedNotes.data.title
                  : `Version ${context.afterVersion.short}`,
              changelog: existingRelease.changelog,
              sections:
                storedNotes.success && storedNotes.data.sections
                  ? storedNotes.data.sections
                  : [],
              promptVersion: existingRelease.promptVersion,
              beforeSha: effectiveCompareBefore,
              headSha: processingAfterSha,
              compareUrl: context.compareUrl,
              prNumbers: normalizeReleasePrNumbers(context.prNumbers),
              commitShas: context.compareCommits.map((commit) => commit.sha),
              releasedAt: existingRelease.createdAt,
              strategy,
              sourceRef,
              previousSourceRef,
              sourceUrl:
                job.sourceUrl ??
                (job.tagName
                  ? `https://github.com/${job.repo}/releases/tag/${encodeURIComponent(job.tagName)}`
                  : context.compareUrl),
            });
          }
        }
        return;
      }

      const releasePrNumbers = normalizeReleasePrNumbers(context.prNumbers);
      const contextWithFilteredFiles = {
        ...context,
        fileChangeSummary: filterHistoryFileSummary(
          context.fileChangeSummary,
          input.contentFilter?.excludedPaths ?? [],
        ),
      };
      const summarizerContext =
        releasePrNumbers.length === context.prNumbers.length
          ? contextWithFilteredFiles
          : { ...contextWithFilteredFiles, prNumbers: releasePrNumbers };

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

      const standaloneCommitHints = buildStandaloneHints(
        context.compareCommits,
      );

      const notes = await input.releaseSummarizer.summarizeRelease({
        context: summarizerContext,
        repo: job.repo,
        branch: job.branch,
        prContributions,
        standaloneCommitHints,
        language: input.summaryLanguage ?? "auto",
      });
      const publish = await publishBestEffort("publishRelease", () =>
        input.destination.publishRelease({
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
        }),
      );

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
        existingEraSha && existingEraSha.length > 0
          ? existingEraSha
          : effectiveCompareBefore;

      const releaseValues = {
        repo: job.repo,
        versionKey: context.newVersionKey,
        shortVersion: context.afterVersion.short,
        buildVersion: context.afterVersion.build,
        previousVersionKey: context.previousVersionKey,
        branch: job.branch,
        headSha: processingAfterSha,
        beforeSha: effectiveCompareBefore,
        prNumbers: releasePrNumbers,
        changelog: notes.changelog,
        sections: {
          sections: notes.sections,
          title: notes.title,
        } as unknown as Record<string, unknown>,
        notionPageId: publish.pageId,
        promptVersion: input.promptVersion,
        marketingEraStartSha,
        createdAt: job.releasedAt,
        updatedAt: new Date(),
      };
      const releaseInsert = input.db
        .insert(releasesTable)
        .values(releaseValues);
      const releaseRows = await (job.force
        ? releaseInsert.onConflictDoUpdate({
            target: [releasesTable.repo, releasesTable.versionKey],
            set: releaseValues,
          })
        : releaseInsert)
        .returning({
          id: releasesTable.id,
          createdAt: releasesTable.createdAt,
        });

      const releaseRow = releaseRows[0];
      if (releaseRow === undefined) {
        throw new Error("Release insert did not return a source record id.");
      }

      if (input.canonicalProjection !== undefined) {
        await input.canonicalProjection.projector.project({
          workspaceId: input.canonicalProjection.workspaceId,
          sourceReleaseId: releaseRow.id,
          repo: job.repo,
          versionKey: context.newVersionKey,
          previousVersionKey: context.previousVersionKey,
          shortVersion: context.afterVersion.short,
          buildVersion: context.afterVersion.build,
          title: notes.title,
          changelog: notes.changelog,
          sections: notes.sections,
          promptVersion: input.promptVersion,
          beforeSha: effectiveCompareBefore,
          headSha: processingAfterSha,
          compareUrl: context.compareUrl,
          prNumbers: releasePrNumbers,
          commitShas: context.compareCommits.map((commit) => commit.sha),
          releasedAt: releaseRow.createdAt,
          strategy,
          sourceRef: job.tagName ?? context.newVersionKey,
          previousSourceRef,
          sourceUrl:
            job.sourceUrl ??
            (job.tagName
              ? `https://github.com/${job.repo}/releases/tag/${encodeURIComponent(job.tagName)}`
              : context.compareUrl),
        });
      }

      await recordLlmUsage({
        db: input.db,
        repo: job.repo,
        jobType: "process_release",
        usage: notes.usage,
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
