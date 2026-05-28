import { Client } from "@notionhq/client";

import { execute as loadEnv } from "@/config/env.js";
import type { Destination, PRSummary, ReleaseNotesSummary } from "@/destinations/destination.js";
import { execute as buildBlocks } from "@/destinations/notion/blocks.js";
import { execute as buildReleaseBlocks } from "@/destinations/notion/release-blocks.js";

interface NotionCreatePageResult {
  id: string;
}

interface NotionClientLike {
  pages: {
    create: (input: unknown) => Promise<NotionCreatePageResult>;
  };
}

export interface ExecuteInput {
  token?: string;
  databaseId?: string;
  /** Database for iOS / release note pages (Phase 2). */
  releasesDatabaseId?: string;
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

const getCredentials = (input: ExecuteInput): { token: string; databaseId: string } => {
  const tokenFromInput = input.token?.trim();
  const databaseIdFromInput = input.databaseId?.trim();
  if (!databaseIdFromInput) {
    throw new Error(
      "Notion PR database id is not configured; pass databaseId from workspace settings.",
    );
  }
  const token =
    tokenFromInput && tokenFromInput.length > 0 ? tokenFromInput : loadEnv().NOTION_TOKEN;
  return { token, databaseId: databaseIdFromInput };
};

const getReleasesDatabaseId = (input: ExecuteInput): string | null => {
  const fromInput = input.releasesDatabaseId?.trim();
  if (fromInput && fromInput.length > 0) {
    return fromInput;
  }
  return null;
};

const toReleaseProperties = (summary: ReleaseNotesSummary): Record<string, unknown> => {
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
          text: { content: summary.prNumbers.length > 0 ? summary.prNumbers.join(", ") : "—" },
        },
      ],
    },
  };
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
  const { token, databaseId } = getCredentials(input);
  const notion = getNotionClientFactory(input.notionClientFactory)(token);

  return {
    publishPR: async (summary) => {
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
        throw new Error(
          "Notion releases database id is not configured; pass releasesDatabaseId from workspace settings.",
        );
      }
      const createInput = {
        parent: { database_id: releasesId },
        properties: toReleaseProperties(summary),
        children: buildReleaseBlocks(summary),
      };
      const response = await notion.pages.create(createInput);

      return { pageId: response.id };
    },
  };
};
