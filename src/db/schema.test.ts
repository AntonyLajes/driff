import { getTableColumns } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  askInteractionsTable,
  changeAreasTable,
  changeContributorsTable,
  changeEvidenceTable,
  changeLineageEntriesTable,
  changeLineagesTable,
  changesTable,
  jobsTable,
  productAreasTable,
  projectVersionsTable,
  promptsTable,
  pullRequestsTable,
  summaryCorrectionsTable,
  userSourceConnectionsTable,
  usersTable,
  webhookEventsTable,
  workspaceDestinationsTable,
  workspaceSettingsTable,
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

  it("should keep an immutable audit trail for summary corrections", () => {
    const columns = getTableColumns(summaryCorrectionsTable);
    const config = getTableConfig(summaryCorrectionsTable);

    expect(columns.workspaceId).toBeDefined();
    expect(columns.sourceRecordType).toBeDefined();
    expect(columns.sourceRecordId).toBeDefined();
    expect(columns.editedByUserId).toBeDefined();
    expect(columns.beforeUserFacing).toBeDefined();
    expect(columns.beforeTechnical).toBeDefined();
    expect(columns.afterUserFacing).toBeDefined();
    expect(columns.afterTechnical).toBeDefined();
    expect(columns.createdAt).toBeDefined();
    expect(config.foreignKeys.length).toBe(2);
    expect(config.indexes.map((candidate) => candidate.config.name)).toEqual(
      expect.arrayContaining([
        "summary_corrections_record_created_at_idx",
        "summary_corrections_workspace_created_at_idx",
      ]),
    );
  });

  it("should store Ask feedback without question, answer or user identity", () => {
    const columns = getTableColumns(askInteractionsTable);
    const config = getTableConfig(askInteractionsTable);

    expect(columns.workspaceId).toBeDefined();
    expect(columns.hadEvidence).toBeDefined();
    expect(columns.feedback).toBeDefined();
    expect(columns.feedbackAt).toBeDefined();
    expect(Object.keys(columns)).not.toEqual(
      expect.arrayContaining(["question", "answer", "userId"]),
    );
    expect(config.foreignKeys.length).toBe(1);
    expect(config.indexes.length).toBe(1);
    expect(config.checks.length).toBe(1);
  });

  it("should store the generated-summary language per workspace", () => {
    const columns = getTableColumns(workspaceSettingsTable);

    expect(columns.summaryLanguage).toBeDefined();
    expect(columns.summaryLanguage.notNull).toBe(true);
    expect(columns.summaryLanguage.default).toBeDefined();
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

  it("should define canonical project versions with source identity", () => {
    const columns = getTableColumns(projectVersionsTable);
    const config = getTableConfig(projectVersionsTable);

    expect(columns.workspaceId).toBeDefined();
    expect(columns.displayVersion).toBeDefined();
    expect(columns.normalizedVersion).toBeDefined();
    expect(columns.buildVersion).toBeDefined();
    expect(columns.title).toBeDefined();
    expect(columns.changelog).toBeDefined();
    expect(columns.sections).toBeDefined();
    expect(columns.promptVersion).toBeDefined();
    expect(columns.status).toBeDefined();
    expect(columns.strategy).toBeDefined();
    expect(columns.sourceRef).toBeDefined();
    expect(columns.sourceReleaseId).toBeDefined();
    expect(columns.previousVersionId).toBeDefined();
    expect(columns.beforeSha).toBeDefined();
    expect(columns.headSha).toBeDefined();
    expect(columns.releasedAt).toBeDefined();
    expect(config.foreignKeys.length).toBe(3);
    expect(config.uniqueConstraints.length).toBe(1);
    expect(config.indexes.length).toBe(3);
    expect(config.indexes.map((candidate) => candidate.config.name)).toContain(
      "project_versions_workspace_timeline_idx",
    );
    expect(config.checks.length).toBe(2);
  });

  it("should define canonical changes with version and workspace boundaries", () => {
    const columns = getTableColumns(changesTable);
    const config = getTableConfig(changesTable);

    expect(columns.workspaceId).toBeDefined();
    expect(columns.versionId).toBeDefined();
    expect(columns.summaryExecutive).toBeDefined();
    expect(columns.summaryTechnical).toBeDefined();
    expect(columns.category).toBeDefined();
    expect(columns.confidence).toBeDefined();
    expect(columns.firstOccurredAt).toBeDefined();
    expect(columns.lastOccurredAt).toBeDefined();
    expect(columns.promptVersion).toBeDefined();
    expect(columns.correctedAt).toBeDefined();
    expect(config.foreignKeys.length).toBe(2);
    expect(config.indexes.length).toBe(3);
    expect(config.indexes.map((candidate) => candidate.config.name)).toContain(
      "changes_workspace_unversioned_timeline_idx",
    );
    expect(config.checks.length).toBe(3);
  });

  it("should define claim-level evidence with idempotent source keys", () => {
    const columns = getTableColumns(changeEvidenceTable);
    const config = getTableConfig(changeEvidenceTable);

    expect(columns.changeId).toBeDefined();
    expect(columns.kind).toBeDefined();
    expect(columns.sourceKey).toBeDefined();
    expect(columns.externalId).toBeDefined();
    expect(columns.url).toBeDefined();
    expect(columns.sha).toBeDefined();
    expect(columns.path).toBeDefined();
    expect(columns.sourceRecordType).toBeDefined();
    expect(columns.sourceRecordId).toBeDefined();
    expect(columns.metadata).toBeDefined();
    expect(config.foreignKeys.length).toBe(1);
    expect(config.uniqueConstraints.length).toBe(1);
    expect(config.indexes.length).toBe(2);
    expect(config.indexes.map((candidate) => candidate.config.name)).toContain(
      "change_evidence_source_record_idx",
    );
    expect(config.checks.length).toBe(1);
  });

  it("should define indexed workspace lineages and ordered change entries", () => {
    const lineageColumns = getTableColumns(changeLineagesTable);
    const lineageConfig = getTableConfig(changeLineagesTable);
    const entryColumns = getTableColumns(changeLineageEntriesTable);
    const entryConfig = getTableConfig(changeLineageEntriesTable);

    expect(lineageColumns.workspaceId).toBeDefined();
    expect(lineageColumns.key).toBeDefined();
    expect(lineageColumns.status).toBeDefined();
    expect(lineageColumns.source).toBeDefined();
    expect(lineageColumns.mergedIntoLineageId).toBeDefined();
    expect(lineageConfig.foreignKeys.length).toBe(2);
    expect(lineageConfig.uniqueConstraints.length).toBe(1);
    expect(
      lineageConfig.indexes.map((candidate) => candidate.config.name),
    ).toEqual(
      expect.arrayContaining([
        "change_lineages_workspace_status_updated_idx",
        "change_lineages_merged_into_lineage_id_idx",
      ]),
    );
    expect(lineageConfig.checks.length).toBe(4);

    expect(entryColumns.lineageId).toBeDefined();
    expect(entryColumns.changeId).toBeDefined();
    expect(entryColumns.relationType).toBeDefined();
    expect(entryColumns.occurredAt).toBeDefined();
    expect(entryColumns.source).toBeDefined();
    expect(entryConfig.primaryKeys.length).toBe(1);
    expect(entryConfig.foreignKeys.length).toBe(2);
    expect(
      entryConfig.indexes.map((candidate) => candidate.config.name),
    ).toEqual(
      expect.arrayContaining([
        "change_lineage_entries_lineage_timeline_idx",
        "change_lineage_entries_change_id_idx",
      ]),
    );
    expect(entryConfig.checks.length).toBe(3);
  });

  it("should define workspace-owned product areas and change assignments", () => {
    const areaColumns = getTableColumns(productAreasTable);
    const areaConfig = getTableConfig(productAreasTable);
    const assignmentColumns = getTableColumns(changeAreasTable);
    const assignmentConfig = getTableConfig(changeAreasTable);

    expect(areaColumns.workspaceId).toBeDefined();
    expect(areaColumns.name).toBeDefined();
    expect(areaColumns.slug).toBeDefined();
    expect(areaColumns.rules).toBeDefined();
    expect(areaConfig.foreignKeys.length).toBe(1);
    expect(areaConfig.uniqueConstraints.length).toBe(1);
    expect(assignmentColumns.changeId).toBeDefined();
    expect(assignmentColumns.areaId).toBeDefined();
    expect(assignmentColumns.confidence).toBeDefined();
    expect(assignmentColumns.source).toBeDefined();
    expect(assignmentConfig.primaryKeys.length).toBe(1);
    expect(assignmentConfig.foreignKeys.length).toBe(2);
    expect(assignmentConfig.indexes.length).toBe(1);
    expect(assignmentConfig.checks.length).toBe(2);
  });

  it("should define explicit contributor roles without productivity metrics", () => {
    const columns = getTableColumns(changeContributorsTable);
    const config = getTableConfig(changeContributorsTable);

    expect(columns.changeId).toBeDefined();
    expect(columns.externalIdentity).toBeDefined();
    expect(columns.displayName).toBeDefined();
    expect(columns.role).toBeDefined();
    expect(columns.sourceUrl).toBeDefined();
    expect(columns.isBot).toBeDefined();
    expect(columns).not.toHaveProperty("score");
    expect(columns).not.toHaveProperty("productivity");
    expect(config.primaryKeys.length).toBe(1);
    expect(config.foreignKeys.length).toBe(1);
    expect(config.indexes.length).toBe(1);
    expect(config.checks.length).toBe(1);
  });

  it("should allow explicit pusher attribution for direct pushes", () => {
    const config = getTableConfig(changeContributorsTable);
    const roleCheck = config.checks.find(
      (candidate) => candidate.name === "change_contributors_role_check",
    );

    expect(roleCheck).toBeDefined();
    if (roleCheck === undefined) {
      throw new Error("Expected contributor role check constraint.");
    }
    expect(new PgDialect().sqlToQuery(roleCheck.value).sql).toContain(
      "'pusher'",
    );
    expect(new PgDialect().sqlToQuery(roleCheck.value).sql).toContain(
      "'merger'",
    );
  });
});
