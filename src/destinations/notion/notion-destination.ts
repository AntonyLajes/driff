import { Client } from "@notionhq/client";

import type {
  Destination,
  PRSummary,
  PushSummary,
  ReleaseNotesSummary,
} from "@/destinations/destination.js";
import { execute as buildBlocks } from "@/destinations/notion/blocks.js";
import { execute as buildPushBlocks } from "@/destinations/notion/push-blocks.js";
import { execute as buildReleaseBlocks } from "@/destinations/notion/release-blocks.js";
import { toMarkdown as buildReleaseMarkdown } from "@/destinations/notion/release-blocks.js";
import {
  ensureDatabaseProperties,
  type NotionSchemaClient,
  PR_PROPERTY_SPEC,
  PUSH_PROPERTY_SPEC,
  RELEASE_PROPERTY_SPEC,
} from "@/destinations/notion/notion-schema.js";

interface NotionCreatePageResult {
  id: string;
}

interface NotionClientLike extends NotionSchemaClient {
  dataSources?: NotionSchemaClient["dataSources"] & {
    query?: (input: unknown) => Promise<unknown>;
  };
  pages: {
    create: (input: unknown) => Promise<NotionCreatePageResult>;
    update?: (input: unknown) => Promise<unknown>;
    updateMarkdown?: (input: unknown) => Promise<unknown>;
  };
}

export interface ExecuteInput {
  token?: string;
  databaseId?: string;
  /** Database for iOS / release note pages (Phase 2). */
  releasesDatabaseId?: string;
  /** Database for direct-push summary pages. */
  pushesDatabaseId?: string;
  notionClientFactory?: (token: string) => NotionClientLike;
}

const getNotionClientFactory = (
  factory?: ExecuteInput["notionClientFactory"],
): ((token: string) => NotionClientLike) => {
  if (factory) {
    return factory;
  }

  return (token) => new Client({ auth: token }) as unknown as NotionClientLike;
};

const getToken = (input: ExecuteInput): string => {
  const tokenFromInput = input.token?.trim();
  if (!tokenFromInput) {
    throw new Error(
      "Notion token is not configured; pass token from the workspace destination.",
    );
  }
  return tokenFromInput;
};

const getPrDatabaseId = (input: ExecuteInput): string | null => {
  const fromInput = input.databaseId?.trim();
  return fromInput && fromInput.length > 0 ? fromInput : null;
};

const getReleasesDatabaseId = (input: ExecuteInput): string | null => {
  const fromInput = input.releasesDatabaseId?.trim();
  if (fromInput && fromInput.length > 0) {
    return fromInput;
  }
  return null;
};

const getPushesDatabaseId = (input: ExecuteInput): string | null => {
  const fromInput = input.pushesDatabaseId?.trim();
  if (fromInput && fromInput.length > 0) {
    return fromInput;
  }
  return null;
};

const toPushProperties = (summary: PushSummary): Record<string, unknown> => {
  return {
    Title: {
      title: [{ type: "text", text: { content: summary.title } }],
    },
    Repo: {
      rich_text: [{ type: "text", text: { content: summary.repo } }],
    },
    Branch: {
      rich_text: [{ type: "text", text: { content: summary.branch } }],
    },
    Pusher: {
      rich_text: summary.pusher
        ? [{ type: "text", text: { content: summary.pusher } }]
        : [],
    },
    "Pushed At": {
      date: { start: summary.pushedAt.toISOString() },
    },
    Commits: {
      number: summary.commitCount,
    },
    Category: {
      select: { name: summary.category },
    },
    Area: {
      rich_text: summary.area
        ? [{ type: "text", text: { content: summary.area } }]
        : [],
    },
    "PR Numbers": {
      rich_text: [
        {
          type: "text",
          text: {
            content:
              summary.prNumbers.length > 0 ? summary.prNumbers.join(", ") : "—",
          },
        },
      ],
    },
    URL: {
      url: summary.compareUrl,
    },
  };
};

const toReleaseProperties = (
  summary: ReleaseNotesSummary,
): Record<string, unknown> => {
  return {
    "Driff Key": {
      rich_text: [
        {
          type: "text",
          text: { content: releaseDriffKey(summary) },
        },
      ],
    },
    Title: {
      title: [{ type: "text", text: { content: summary.title } }],
    },
    Repo: {
      rich_text: [{ type: "text", text: { content: summary.repo } }],
    },
    Branch: {
      rich_text: [{ type: "text", text: { content: summary.branch } }],
    },
    Version: {
      rich_text: [{ type: "text", text: { content: summary.newVersionKey } }],
    },
    "Short Version": {
      rich_text: [{ type: "text", text: { content: summary.shortVersion } }],
    },
    Build: {
      rich_text: [{ type: "text", text: { content: summary.buildVersion } }],
    },
    "Previous Version": {
      rich_text: [
        {
          type: "text",
          text: { content: summary.previousVersionKey ?? "—" },
        },
      ],
    },
    URL: {
      url: summary.compareUrl,
    },
    "PR Numbers": {
      rich_text: [
        {
          type: "text",
          text: {
            content:
              summary.prNumbers.length > 0 ? summary.prNumbers.join(", ") : "—",
          },
        },
      ],
    },
  };
};

const releaseDriffKey = (summary: ReleaseNotesSummary): string =>
  `github:${summary.repo}:release:${summary.newVersionKey}`;

const firstPageId = (result: unknown): string | null => {
  const rows = (result as { results?: Array<{ id?: unknown }> } | null)
    ?.results;
  const id = Array.isArray(rows) ? rows[0]?.id : undefined;
  return typeof id === "string" && id.length > 0 ? id : null;
};

const findExistingReleasePage = async (input: {
  notion: NotionClientLike;
  dataSourceId: string | null;
  summary: ReleaseNotesSummary;
}): Promise<string | null> => {
  const query = input.notion.dataSources?.query;
  if (input.dataSourceId === null || query === undefined) return null;

  const byKey = await query({
    data_source_id: input.dataSourceId,
    filter: {
      property: "Driff Key",
      rich_text: { equals: releaseDriffKey(input.summary) },
    },
    page_size: 1,
    result_type: "page",
  });
  const keyMatch = firstPageId(byKey);
  if (keyMatch !== null) return keyMatch;

  // Adopt release pages created before Driff Key existed instead of duplicating them.
  const legacy = await query({
    data_source_id: input.dataSourceId,
    filter: {
      and: [
        { property: "Repo", rich_text: { equals: input.summary.repo } },
        {
          property: "Version",
          rich_text: { equals: input.summary.newVersionKey },
        },
      ],
    },
    page_size: 1,
    result_type: "page",
  });
  return firstPageId(legacy);
};

const toProperties = (summary: PRSummary): Record<string, unknown> => {
  return {
    Title: {
      title: [{ type: "text", text: { content: summary.title } }],
    },
    Repo: {
      rich_text: [{ type: "text", text: { content: summary.repo } }],
    },
    "PR Number": {
      number: summary.prNumber,
    },
    Author: {
      rich_text: [{ type: "text", text: { content: summary.author } }],
    },
    "Merged At": {
      date: { start: summary.mergedAt.toISOString() },
    },
    Category: {
      select: { name: summary.category },
    },
    Area: {
      rich_text: summary.area
        ? [{ type: "text", text: { content: summary.area } }]
        : [],
    },
    URL: {
      url: summary.prUrl,
    },
  };
};

export const execute = (input: ExecuteInput = {}): Destination => {
  const token = getToken(input);
  const notion = getNotionClientFactory(input.notionClientFactory)(token);

  return {
    publishPR: async (summary) => {
      const databaseId = getPrDatabaseId(input);
      if (!databaseId) {
        return { pageId: "" };
      }
      await ensureDatabaseProperties(notion, databaseId, PR_PROPERTY_SPEC);
      const createInput = {
        parent: { database_id: databaseId },
        properties: toProperties(summary),
        children: buildBlocks(summary),
      };
      const response = await notion.pages.create(createInput);

      return { pageId: response.id };
    },
    publishRelease: async (summary) => {
      const releasesId = getReleasesDatabaseId(input);
      if (!releasesId) {
        return { pageId: "" };
      }
      const dataSourceId = await ensureDatabaseProperties(
        notion,
        releasesId,
        RELEASE_PROPERTY_SPEC,
      );
      const properties = toReleaseProperties(summary);
      const existingPageId = await findExistingReleasePage({
        notion,
        dataSourceId,
        summary,
      });
      if (
        existingPageId !== null &&
        notion.pages.update !== undefined &&
        notion.pages.updateMarkdown !== undefined
      ) {
        await notion.pages.update({ page_id: existingPageId, properties });
        await notion.pages.updateMarkdown({
          page_id: existingPageId,
          type: "replace_content",
          replace_content: {
            new_str: buildReleaseMarkdown(summary),
            allow_deleting_content: true,
          },
        });
        return { pageId: existingPageId };
      }
      const createInput = {
        parent: { database_id: releasesId },
        properties,
        children: buildReleaseBlocks(summary),
      };
      const response = await notion.pages.create(createInput);

      return { pageId: response.id };
    },
    publishPush: async (summary) => {
      const pushesId = getPushesDatabaseId(input);
      if (!pushesId) {
        return { pageId: "" };
      }
      await ensureDatabaseProperties(notion, pushesId, PUSH_PROPERTY_SPEC);
      const createInput = {
        parent: { database_id: pushesId },
        properties: toPushProperties(summary),
        children: buildPushBlocks(summary),
      };
      const response = await notion.pages.create(createInput);

      return { pageId: response.id };
    },
  };
};
