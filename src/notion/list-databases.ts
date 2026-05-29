import { Client, isFullDatabase, isFullDataSource, type Client as NotionClient } from "@notionhq/client";

export type NotionDatabaseListItem = {
  id: string;
  title: string;
  url: string | null;
};

export type NotionDatabaseSuggestions = {
  prDatabaseId: string | null;
  releasesDatabaseId: string | null;
};

const extractRichText = (items: Array<{ plain_text?: string }> | undefined): string => {
  if (items === undefined || items.length === 0) {
    return "Untitled";
  }
  const text = items
    .map((item) => item.plain_text?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("");
  return text.length > 0 ? text : "Untitled";
};

const normalizeId = (id: string): string => id.replace(/-/g, "");

const scoreTitle = (title: string, keywords: readonly string[]): number => {
  const normalized = title.trim().toLowerCase();
  if (normalized.length === 0) {
    return 0;
  }
  let score = 0;
  for (const keyword of keywords) {
    if (normalized.includes(keyword)) {
      score += keyword.length >= 6 ? 3 : 2;
    }
  }
  return score;
};

export const suggestNotionDatabaseRoles = (
  databases: readonly NotionDatabaseListItem[],
): NotionDatabaseSuggestions => {
  const prKeywords = ["pull request", "pull requests", "merged pr", "pr summary", "pr ", " pr", "prs"] as const;
  const releaseKeywords = ["release", "releases", "version", "changelog", "ship"] as const;

  const pickBest = (keywords: readonly string[], excludeId: string | null): string | null => {
    let best: { id: string; score: number } | null = null;
    for (const db of databases) {
      if (excludeId !== null && normalizeId(db.id) === normalizeId(excludeId)) {
        continue;
      }
      const score = scoreTitle(db.title, keywords);
      if (score <= 0) {
        continue;
      }
      if (best === null || score > best.score) {
        best = { id: db.id, score };
      }
    }
    return best?.id ?? null;
  };

  const prDatabaseId = pickBest(prKeywords, null);
  const releasesDatabaseId = pickBest(releaseKeywords, prDatabaseId);
  return { prDatabaseId, releasesDatabaseId };
};

export const listNotionDatabasesWithClient = async (
  notion: Pick<NotionClient, "search">,
): Promise<NotionDatabaseListItem[]> => {
  const byId = new Map<string, NotionDatabaseListItem>();
  let cursor: string | undefined;

  do {
    const response = await notion.search({
      page_size: 100,
      start_cursor: cursor,
    });

    for (const result of response.results) {
      if (isFullDatabase(result)) {
        const database = result as {
          id: string;
          title: Array<{ plain_text?: string }>;
          url: string | null;
        };
        byId.set(normalizeId(database.id), {
          id: database.id,
          title: extractRichText(database.title),
          url: database.url ?? null,
        });
        continue;
      }
      if (isFullDataSource(result) && result.database_parent.type === "database_id") {
        const databaseId = result.database_parent.database_id;
        if (!byId.has(normalizeId(databaseId))) {
          byId.set(normalizeId(databaseId), {
            id: databaseId,
            title: extractRichText(result.title),
            url: result.url ?? null,
          });
        }
      }
    }

    cursor =
      response.has_more && response.next_cursor !== null ? response.next_cursor : undefined;
  } while (cursor !== undefined);

  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
};

export const listNotionDatabases = async (token: string): Promise<NotionDatabaseListItem[]> => {
  const notion = new Client({ auth: token });
  return listNotionDatabasesWithClient(notion);
};
