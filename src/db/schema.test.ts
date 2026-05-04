import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  jobsTable,
  promptsTable,
  pullRequestsTable,
  usersTable,
  webhookEventsTable,
} from "@/db/schema.js";

describe("db/schema tables", () => {
  it("should define webhook events table columns", () => {
    const columns = getTableColumns(webhookEventsTable);
    const config = getTableConfig(webhookEventsTable);

    expect(columns.deliveryId).toBeDefined();
    expect(columns.eventType).toBeDefined();
    expect(columns.payload).toBeDefined();
    expect(columns.processedAt).toBeDefined();
    expect(config.uniqueConstraints.length).toBe(1);
  });

  it("should define pull requests table columns", () => {
    const columns = getTableColumns(pullRequestsTable);
    const config = getTableConfig(pullRequestsTable);

    expect(columns.repo).toBeDefined();
    expect(columns.prNumber).toBeDefined();
    expect(columns.summaryUserFacing).toBeDefined();
    expect(columns.notionPageId).toBeDefined();
    expect(columns.promptVersion).toBeDefined();
    expect(config.uniqueConstraints.length).toBe(1);
  });

  it("should define jobs table columns", () => {
    const columns = getTableColumns(jobsTable);
    const config = getTableConfig(jobsTable);

    expect(columns.type).toBeDefined();
    expect(columns.payload).toBeDefined();
    expect(columns.status).toBeDefined();
    expect(columns.availableAt).toBeDefined();
    expect(config.indexes.length).toBe(1);
  });

  it("should define prompts table columns", () => {
    const columns = getTableColumns(promptsTable);
    const config = getTableConfig(promptsTable);

    expect(columns.name).toBeDefined();
    expect(columns.version).toBeDefined();
    expect(columns.content).toBeDefined();
    expect(config.uniqueConstraints.length).toBe(1);
  });

  it("should define users table for Google-linked accounts", () => {
    const columns = getTableColumns(usersTable);
    const config = getTableConfig(usersTable);

    expect(columns.googleSub).toBeDefined();
    expect(columns.email).toBeDefined();
    expect(config.uniqueConstraints.length).toBe(1);
  });
});
