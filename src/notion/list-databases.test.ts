import { describe, expect, it, vi } from "vitest";

import {
  listNotionDatabasesWithClient,
  suggestNotionDatabaseRoles,
  type NotionDatabaseListItem,
} from "@/notion/list-databases.js";

describe("suggestNotionDatabaseRoles", () => {
  const databases: NotionDatabaseListItem[] = [
    { id: "pr-db", title: "PR Summaries", url: null },
    { id: "rel-db", title: "Releases", url: null },
    { id: "misc-db", title: "Docs", url: null },
  ];

  it("should suggest PR and release databases from titles", () => {
    expect(suggestNotionDatabaseRoles(databases)).toEqual({
      prDatabaseId: "pr-db",
      releasesDatabaseId: "rel-db",
    });
  });

  it("should avoid selecting the same database twice", () => {
    const onlyPr = [{ id: "pr-db", title: "PR Releases", url: null }];
    expect(suggestNotionDatabaseRoles(onlyPr)).toEqual({
      prDatabaseId: "pr-db",
      releasesDatabaseId: null,
    });
  });
});

describe("listNotionDatabasesWithClient", () => {
  it("should map database search results", async () => {
    const search = vi.fn(async () => ({
      has_more: false,
      next_cursor: null,
      results: [
        {
          object: "database",
          id: "db-1",
          title: [{ plain_text: "Mobile PRs" }],
          url: "https://notion.so/db-1",
        },
      ],
    }));

    const items = await listNotionDatabasesWithClient({ search } as never);
    expect(items).toEqual([{ id: "db-1", title: "Mobile PRs", url: "https://notion.so/db-1" }]);
    expect(search).toHaveBeenCalledOnce();
  });

  it("should map data_source results (Notion-Version 2025-09-03) to their database id", async () => {
    const search = vi.fn(async () => ({
      has_more: false,
      next_cursor: null,
      results: [
        {
          object: "data_source",
          id: "ds-1",
          database_id: "db-9",
          title: [{ plain_text: "Releases" }],
          // database_parent is the parent OF the database (a page), not a database_id
          database_parent: { type: "page_id", page_id: "page-1" },
          parent: { type: "database_id", database_id: "db-9" },
        },
      ],
    }));

    const items = await listNotionDatabasesWithClient({ search } as never);
    expect(items).toEqual([{ id: "db-9", title: "Releases", url: null }]);
  });

  it("should fall back to parent.database_id when the direct field is absent", async () => {
    const search = vi.fn(async () => ({
      has_more: false,
      next_cursor: null,
      results: [
        {
          object: "data_source",
          id: "ds-2",
          title: [{ plain_text: "PRs" }],
          parent: { type: "database_id", database_id: "db-7" },
        },
      ],
    }));

    const items = await listNotionDatabasesWithClient({ search } as never);
    expect(items).toEqual([{ id: "db-7", title: "PRs", url: null }]);
  });
});
