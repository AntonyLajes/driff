import { describe, expect, it, vi } from "vitest";

import {
  ensureDatabaseProperties,
  PUSH_PROPERTY_SPEC,
} from "@/destinations/notion/notion-schema.js";

const buildClient = (opts: {
  dataSourceId?: string | null;
  existingProperties?: Record<string, unknown>;
}) => {
  const retrieveDatabase = vi.fn(async () => ({
    data_sources:
      opts.dataSourceId === null ? [] : [{ id: opts.dataSourceId ?? "ds-1" }],
  }));
  const retrieveDataSource = vi.fn(async () => ({
    properties: opts.existingProperties ?? {},
  }));
  const updateDataSource = vi.fn<
    (input: {
      data_source_id: string;
      properties: Record<string, unknown>;
    }) => Promise<unknown>
  >(async () => ({}));
  const notion = {
    databases: { retrieve: retrieveDatabase },
    dataSources: { retrieve: retrieveDataSource, update: updateDataSource },
  };
  return { notion, retrieveDatabase, retrieveDataSource, updateDataSource };
};

describe("destinations/notion/notion-schema ensureDatabaseProperties", () => {
  it("should add only the properties the data source is missing", async () => {
    const { notion, updateDataSource } = buildClient({
      existingProperties: {
        Title: { title: {} },
        Repo: { rich_text: {} },
        Branch: { rich_text: {} },
        "PR Numbers": { rich_text: {} },
        URL: { url: {} },
      },
    });

    await ensureDatabaseProperties(notion, "db-1", PUSH_PROPERTY_SPEC);

    expect(updateDataSource).toHaveBeenCalledOnce();
    const arg = updateDataSource.mock.calls[0]![0];
    expect(arg.data_source_id).toBe("ds-1");
    // Missing ones get created; already-present ones are left alone.
    expect(Object.keys(arg.properties).sort()).toEqual(
      ["Area", "Category", "Commits", "Pushed At", "Pusher"].sort(),
    );
    expect(arg.properties).not.toHaveProperty("Repo");
    expect(arg.properties).not.toHaveProperty("Title");
  });

  it("should not call update when every required property already exists", async () => {
    const existing: Record<string, unknown> = { Title: { title: {} } };
    for (const name of Object.keys(PUSH_PROPERTY_SPEC)) {
      existing[name] = {};
    }
    const { notion, updateDataSource } = buildClient({
      existingProperties: existing,
    });

    await ensureDatabaseProperties(notion, "db-1", PUSH_PROPERTY_SPEC);

    expect(updateDataSource).not.toHaveBeenCalled();
  });

  it("should no-op when the client cannot introspect the schema", async () => {
    const update = vi.fn();
    const notion = { pages: { create: vi.fn() } } as Parameters<
      typeof ensureDatabaseProperties
    >[0];

    await expect(
      ensureDatabaseProperties(notion, "db-1", PUSH_PROPERTY_SPEC),
    ).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("should no-op when the database has no resolvable data source", async () => {
    const { notion, retrieveDataSource, updateDataSource } = buildClient({
      dataSourceId: null,
    });

    await ensureDatabaseProperties(notion, "db-1", PUSH_PROPERTY_SPEC);

    expect(retrieveDataSource).not.toHaveBeenCalled();
    expect(updateDataSource).not.toHaveBeenCalled();
  });
});
