/**
 * Auto-provisioning of the Notion database schema.
 *
 * Driff writes a fixed set of page properties for each summary type. If the
 * target Notion database (data source) is missing any of those properties,
 * `pages.create` fails with a `validation_error` ("X is not a property that
 * exists"). Rather than make users add columns by hand, we ensure the required
 * properties exist before publishing — adding any that are missing via
 * `dataSources.update`.
 *
 * Notion-Version 2025-09-03+ moved the property schema from the database onto
 * its data source(s); a `database_id` resolves to one or more data sources and
 * the properties live there. We resolve the database's first data source and
 * read/patch its properties.
 */

/** A Notion property *definition* (the create-time schema, not a page value). */
export type NotionPropertyDefinition = Record<string, unknown>;
export type NotionPropertySpec = Record<string, NotionPropertyDefinition>;

const TEXT: NotionPropertyDefinition = { rich_text: {} };
const NUMBER: NotionPropertyDefinition = { number: {} };
const DATE: NotionPropertyDefinition = { date: {} };
const SELECT: NotionPropertyDefinition = { select: {} };
const URL: NotionPropertyDefinition = { url: {} };

// `Title` is intentionally omitted from every spec: each data source already has
// exactly one title property (Driff writes it as "Title"), and a second one
// cannot be added. The remaining properties mirror the page-create payloads in
// notion-destination.ts and MUST stay in sync with them.

export const PR_PROPERTY_SPEC: NotionPropertySpec = {
  Repo: TEXT,
  "PR Number": NUMBER,
  Author: TEXT,
  "Merged At": DATE,
  Category: SELECT,
  Area: TEXT,
  URL,
};

export const RELEASE_PROPERTY_SPEC: NotionPropertySpec = {
  "Driff Key": TEXT,
  Repo: TEXT,
  Branch: TEXT,
  Version: TEXT,
  "Short Version": TEXT,
  Build: TEXT,
  "Previous Version": TEXT,
  URL,
  "PR Numbers": TEXT,
};

export const PUSH_PROPERTY_SPEC: NotionPropertySpec = {
  Repo: TEXT,
  Branch: TEXT,
  Pusher: TEXT,
  "Pushed At": DATE,
  Commits: NUMBER,
  Category: SELECT,
  Area: TEXT,
  "PR Numbers": TEXT,
  URL,
};

/** Minimal slice of the Notion client used to provision a database schema. */
export interface NotionSchemaClient {
  databases?: {
    retrieve: (input: { database_id: string }) => Promise<unknown>;
  };
  dataSources?: {
    retrieve: (input: { data_source_id: string }) => Promise<unknown>;
    update: (input: {
      data_source_id: string;
      properties: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

const resolveDataSourceId = (database: unknown): string | null => {
  const sources = (database as { data_sources?: Array<{ id?: string }> } | null)
    ?.data_sources;
  const id = Array.isArray(sources) ? sources[0]?.id : undefined;
  return typeof id === "string" && id.length > 0 ? id : null;
};

const existingPropertyNames = (dataSource: unknown): Set<string> => {
  const props = (dataSource as { properties?: Record<string, unknown> } | null)
    ?.properties;
  return new Set(props && typeof props === "object" ? Object.keys(props) : []);
};

/**
 * Adds any properties from `spec` that the database's data source is missing.
 * No-op when the client cannot introspect the schema (e.g. a test double that
 * only mocks `pages.create`) or when every property already exists.
 */
export const ensureDatabaseProperties = async (
  notion: NotionSchemaClient,
  databaseId: string,
  spec: NotionPropertySpec,
): Promise<string | null> => {
  if (
    !notion.databases?.retrieve ||
    !notion.dataSources?.retrieve ||
    !notion.dataSources?.update
  ) {
    return null;
  }

  const database = await notion.databases.retrieve({ database_id: databaseId });
  const dataSourceId = resolveDataSourceId(database);
  if (dataSourceId === null) {
    return null;
  }

  const dataSource = await notion.dataSources.retrieve({
    data_source_id: dataSourceId,
  });
  const existing = existingPropertyNames(dataSource);

  const missing: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(spec)) {
    if (!existing.has(name)) {
      missing[name] = definition;
    }
  }

  if (Object.keys(missing).length === 0) {
    return dataSourceId;
  }

  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: missing,
  });
  return dataSourceId;
};
