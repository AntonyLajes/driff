import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  jobsTable,
  promptsTable,
  pullRequestsTable,
  userSourceConnectionsTable,
  usersTable,
  webhookEventsTable,
  workspaceDestinationsTable,
  workspacesTable,
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

  it("should define workspaces table scoped per team", () => {
    const columns = getTableColumns(workspacesTable);
    const config = getTableConfig(workspacesTable);

    expect(columns.teamId).toBeDefined();
    expect(columns.userId).toBeDefined();
    expect(columns.slug).toBeDefined();
    expect(columns.workspaceKind).toBeDefined();
    expect(columns.sourceProvider).toBeDefined();
    expect(columns.repoFullName).toBeDefined();
    expect(columns.repoDefaultBranch).toBeDefined();
    expect(config.uniqueConstraints.length).toBe(1);
    // teamIdIdx + userIdIdx + partial unique index on (sourceProvider, repoFullName)
    expect(config.indexes.length).toBe(3);
  });

  it("should define user_source_connections for per-provider OAuth tokens", () => {
    const columns = getTableColumns(userSourceConnectionsTable);
    const config = getTableConfig(userSourceConnectionsTable);

    expect(columns.userId).toBeDefined();
    expect(columns.provider).toBeDefined();
    expect(columns.accessTokenCiphertext).toBeDefined();
    expect(columns.externalLogin).toBeDefined();
    expect(columns.externalAccountId).toBeDefined();
    // composite primary key (user_id, provider)
    expect(config.primaryKeys.length).toBe(1);
  });

  it("should define workspace_destinations for per-workspace outputs", () => {
    const columns = getTableColumns(workspaceDestinationsTable);
    const config = getTableConfig(workspaceDestinationsTable);

    expect(columns.workspaceId).toBeDefined();
    expect(columns.type).toBeDefined();
    expect(columns.enabled).toBeDefined();
    expect(columns.config).toBeDefined();
    expect(columns.secretCiphertext).toBeDefined();
    // unique(workspace_id, type)
    expect(config.uniqueConstraints.length).toBe(1);
    expect(config.indexes.length).toBe(1);
  });
});
