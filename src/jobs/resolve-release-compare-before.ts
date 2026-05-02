import { and, asc, desc, eq, isNotNull } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { releasesTable } from "@/db/schema.js";
import type { IosPlistVersion } from "@/lib/plist-version.js";

export interface ExecuteInput {
  db: Database;
  repo: string;
  branch: string;
  beforeVersion: IosPlistVersion | null;
  afterVersion: IosPlistVersion;
  webhookBeforeSha: string;
  releaseCompareRootSha: string | null | undefined;
}

const trimSha = (sha: string): string => sha.trim();

const fallbackCompareBefore = (webhookBefore: string, root: string | null | undefined): string => {
  const rootTrim = root?.trim();
  if (rootTrim && rootTrim.length > 0) {
    return rootTrim;
  }
  return trimSha(webhookBefore);
};

/**
 * Resolves the left SHA for GitHub compare (`base...head`) while plist/pbx reads stay on webhook SHAs.
 * See `docs/release-compare-windows.md`.
 */
export const execute = async (input: ExecuteInput): Promise<string> => {
  const webhookBefore = trimSha(input.webhookBeforeSha);
  const root = input.releaseCompareRootSha;
  const afterShort = input.afterVersion.short;
  const afterBuild = input.afterVersion.build;
  const beforeVersion = input.beforeVersion;

  // Build-only bump: same marketing short, different build.
  if (
    beforeVersion !== null &&
    beforeVersion.short === afterShort &&
    beforeVersion.build !== afterBuild
  ) {
    const prior = await input.db
      .select({ headSha: releasesTable.headSha })
      .from(releasesTable)
      .where(
        and(
          eq(releasesTable.repo, input.repo),
          eq(releasesTable.branch, input.branch),
          eq(releasesTable.shortVersion, afterShort),
        ),
      )
      .orderBy(desc(releasesTable.createdAt))
      .limit(1);

    const head = prior[0]?.headSha;
    if (head && head.trim().length > 0) {
      return head.trim();
    }
    return fallbackCompareBefore(webhookBefore, root);
  }

  // Marketing bump: short version changed between webhook refs.
  if (beforeVersion !== null && beforeVersion.short !== afterShort) {
    const oldShort = beforeVersion.short;

    const eraAnchor = await input.db
      .select({ marketingEraStartSha: releasesTable.marketingEraStartSha })
      .from(releasesTable)
      .where(
        and(
          eq(releasesTable.repo, input.repo),
          eq(releasesTable.branch, input.branch),
          eq(releasesTable.shortVersion, oldShort),
          isNotNull(releasesTable.marketingEraStartSha),
        ),
      )
      .orderBy(asc(releasesTable.createdAt))
      .limit(1);

    const eraSha = eraAnchor[0]?.marketingEraStartSha;
    if (eraSha && eraSha.trim().length > 0) {
      return eraSha.trim();
    }

    const lastOnOldLine = await input.db
      .select({ headSha: releasesTable.headSha })
      .from(releasesTable)
      .where(
        and(
          eq(releasesTable.repo, input.repo),
          eq(releasesTable.branch, input.branch),
          eq(releasesTable.shortVersion, oldShort),
        ),
      )
      .orderBy(desc(releasesTable.createdAt))
      .limit(1);

    const lastHead = lastOnOldLine[0]?.headSha;
    if (lastHead && lastHead.trim().length > 0) {
      return lastHead.trim();
    }

    return fallbackCompareBefore(webhookBefore, root);
  }

  return webhookBefore;
};
