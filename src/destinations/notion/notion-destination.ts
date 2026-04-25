import { Client } from "@notionhq/client";

import { execute as loadEnv } from "@/config/env.js";
import type { Destination, PRSummary } from "@/destinations/destination.js";
import { execute as buildBlocks } from "@/destinations/notion/blocks.js";

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
  if (input.token && input.databaseId) {
    return {
      token: input.token,
      databaseId: input.databaseId,
    };
  }

  const env = loadEnv();
  return {
    token: input.token ?? env.NOTION_TOKEN,
    databaseId: input.databaseId ?? env.NOTION_DATABASE_ID,
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
  };
};
