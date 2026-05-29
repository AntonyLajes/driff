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
});
