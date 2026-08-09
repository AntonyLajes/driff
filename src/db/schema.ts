import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const webhookEventsTable = pgTable(
  "webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: text("delivery_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => ({
    deliveryIdUnique: unique("webhook_events_delivery_id_unique").on(
      table.deliveryId,
    ),
  }),
);

export const pullRequestsTable = pgTable(
  "pull_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    title: text("title").notNull(),
    author: text("author").notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull(),
    headSha: text("head_sha").notNull(),
    baseBranch: text("base_branch").notNull(),
    summaryUserFacing: text("summary_user_facing"),
    summaryTechnical: text("summary_technical"),
    category: text("category"),
    area: text("area"),
    /** Diff stats captured from the PR files listing (null on legacy rows). */
    additions: integer("additions"),
    deletions: integer("deletions"),
    changedFiles: integer("changed_files"),
    notionPageId: text("notion_page_id"),
    promptVersion: integer("prompt_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    repoPrNumberUnique: unique("pull_requests_repo_pr_number_unique").on(
      table.repo,
      table.prNumber,
    ),
  }),
);

export const jobsTable = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    statusAvailableAtIndex: index("jobs_status_available_at_idx").on(
      table.status,
      table.availableAt,
    ),
  }),
);

export const releasesTable = pgTable(
  "releases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repo: text("repo").notNull(),
    versionKey: text("version_key").notNull(),
    shortVersion: text("short_version").notNull(),
    buildVersion: text("build_version").notNull(),
    previousVersionKey: text("previous_version_key"),
    branch: text("branch").notNull(),
    headSha: text("head_sha").notNull(),
    beforeSha: text("before_sha").notNull(),
    prNumbers: jsonb("pr_numbers").$type<number[]>().notNull(),
    changelog: text("changelog").notNull(),
    sections: jsonb("sections").$type<Record<string, unknown>>(),
    notionPageId: text("notion_page_id"),
    promptVersion: integer("prompt_version"),
    /**
     * Git SHA marking the start of this marketing line's "era" (first row for a given
     * `short_version`); reused for later builds on the same line and for marketing-bump compares.
     */
    marketingEraStartSha: text("marketing_era_start_sha"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    repoVersionKeyUnique: unique("releases_repo_version_key_unique").on(
      table.repo,
      table.versionKey,
    ),
  }),
);

/**
 * Direct pushes to a tracked branch (hotfixes / single-branch workflows). Unlike releases,
 * these are not gated on a version bump and are summarized per push range (`before_sha`..`after_sha`).
 */
export const pushesTable = pgTable(
  "pushes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    beforeSha: text("before_sha").notNull(),
    afterSha: text("after_sha").notNull(),
    pusher: text("pusher"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }).notNull(),
    commitCount: integer("commit_count").notNull(),
    prNumbers: jsonb("pr_numbers").$type<number[]>().notNull(),
    title: text("title").notNull(),
    summaryUserFacing: text("summary_user_facing"),
    summaryTechnical: text("summary_technical"),
    category: text("category"),
    area: text("area"),
    /** Diff stats captured from the push compare (null on legacy rows). */
    additions: integer("additions"),
    deletions: integer("deletions"),
    changedFiles: integer("changed_files"),
    compareUrl: text("compare_url"),
    notionPageId: text("notion_page_id"),
    promptVersion: integer("prompt_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    repoAfterShaUnique: unique("pushes_repo_after_sha_unique").on(
      table.repo,
      table.afterSha,
    ),
  }),
);

/**
 * Per-summary LLM token usage (metering only — no enforcement yet). Feeds future
 * usage-based pricing/tiers; see the billing-tiers project note. One row per
 * successful summarization (PR / release / push).
 */
export const llmUsageTable = pgTable(
  "llm_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repo: text("repo").notNull(),
    jobType: text("job_type").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    repoCreatedAtIndex: index("llm_usage_repo_created_at_idx").on(
      table.repo,
      table.createdAt,
    ),
  }),
);

/**
 * Operator accounts linked to Google Sign-In (`sub` from OIDC userinfo).
 */
export const usersTable = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    googleSub: text("google_sub").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    picture: text("picture"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    googleSubUnique: unique("users_google_sub_unique").on(table.googleSub),
  }),
);

/**
 * Teams own workspaces. Every user gets a personal team on signup whose id
 * EQUALS the user id (deterministic backfill + zero-query default context);
 * personal teams can't be renamed, deleted or gain members.
 */
export const teamsTable = pgTable(
  "teams",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isPersonal: boolean("is_personal").default(false).notNull(),
    /** Member cap enforced on invites; provisional value until billing lands. */
    maxMembers: integer("max_members").default(25).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    slugUnique: unique("teams_slug_unique").on(table.slug),
  }),
);

/** Membership + role. Roles: `owner` | `admin` | `member` (see docs/permissions). */
export const teamMembersTable = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.teamId, table.userId] }),
    userIdIdx: index("team_members_user_id_idx").on(table.userId),
  }),
);

/** Pending email invites; `token` is the single-use secret in the invite link. */
export const teamInvitesTable = pgTable(
  "team_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    token: text("token").notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(
      () => usersTable.id,
      {
        onDelete: "set null",
      },
    ),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tokenUnique: unique("team_invites_token_unique").on(table.token),
    teamIdIdx: index("team_invites_team_id_idx").on(table.teamId),
  }),
);

/**
 * Per-provider source OAuth (user-to-server) tokens for listing repos and reading metadata.
 * One row per (user, provider). Access tokens are stored sealed with `AUTH_JWT_SECRET`
 * (see `token-aes.ts`). `provider` is `github` today; `gitlab`/`bitbucket` later.
 */
export const userSourceConnectionsTable = pgTable(
  "user_source_connections",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    scope: text("scope"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    /** Provider-side account id (e.g. GitHub user id). */
    externalAccountId: text("external_account_id"),
    /** Provider-side login/handle (e.g. GitHub login). */
    externalLogin: text("external_login"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.provider] }),
  }),
);

/**
 * Per-user workspaces (apps / projects). Integration settings for each row live in
 * `workspace_settings` with matching `workspace_id` (or legacy global settings when null).
 */
export const workspacesTable = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Owning team — access control is team-membership based. */
    teamId: uuid("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    /** Creator; also whose GitHub connection seeded the repo link. */
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /**
     * Source provider the linked repo belongs to (`github` today; `gitlab`/`bitbucket` later).
     */
    sourceProvider: text("source_provider").notNull().default("github"),
    /**
     * Optional app kind for onboarding / releases (`ios_plist`, `ios_pbx`, `react_native_expo`, …).
     * Null until detection or manual selection.
     */
    workspaceKind: text("workspace_kind"),
    /** Linked repo full name (`owner/name`) after onboarding. */
    repoFullName: text("repo_full_name"),
    /** Default branch from the source provider metadata (optional cache). */
    repoDefaultBranch: text("repo_default_branch"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    teamSlugUnique: unique("workspaces_team_id_slug_unique").on(
      table.teamId,
      table.slug,
    ),
    teamIdIdx: index("workspaces_team_id_idx").on(table.teamId),
    userIdIdx: index("workspaces_user_id_idx").on(table.userId),
    // One workspace per linked repo, globally per provider (webhook routing is repo-keyed).
    providerRepoUnique: uniqueIndex("workspaces_provider_repo_unique")
      .on(table.sourceProvider, table.repoFullName)
      .where(sql`${table.repoFullName} IS NOT NULL`),
  }),
);

/** Immutable audit trail for human corrections made to generated summaries. */
export const summaryCorrectionsTable = pgTable(
  "summary_corrections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    sourceRecordType: text("source_record_type").notNull(),
    sourceRecordId: uuid("source_record_id").notNull(),
    editedByUserId: uuid("edited_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    beforeUserFacing: text("before_user_facing"),
    beforeTechnical: text("before_technical"),
    afterUserFacing: text("after_user_facing").notNull(),
    afterTechnical: text("after_technical"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    recordCreatedAtIdx: index("summary_corrections_record_created_at_idx").on(
      table.sourceRecordType,
      table.sourceRecordId,
      table.createdAt,
    ),
    workspaceCreatedAtIdx: index(
      "summary_corrections_workspace_created_at_idx",
    ).on(table.workspaceId, table.createdAt),
  }),
);

export interface HistoryImportFailure {
  sourceKind: "pull_request" | "release" | "commit";
  sourceKey: string;
  message: string;
  /** Kept while old clients still expose PR-specific progress. */
  prNumber?: number;
}

/**
 * Bounded, resumable imports used to give a newly linked workspace immediate value.
 * The import orchestrator reuses the regular process_pr pipeline and checkpoints each
 * completed PR so a worker retry never starts the whole window from zero.
 */
export const historyImportsTable = pgTable(
  "history_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    periodMonths: integer("period_months").notNull().default(12),
    maxPullRequests: integer("max_pull_requests").notNull().default(100),
    totalItems: integer("total_items").notNull().default(0),
    processedItems: integer("processed_items").notNull().default(0),
    failedItems: integer("failed_items").notNull().default(0),
    completedPrNumbers: jsonb("completed_pr_numbers")
      .$type<number[]>()
      .notNull()
      .default([]),
    completedSourceKeys: jsonb("completed_source_keys")
      .$type<string[]>()
      .notNull()
      .default([]),
    failures: jsonb("failures")
      .$type<HistoryImportFailure[]>()
      .notNull()
      .default([]),
    truncated: boolean("truncated").notNull().default(false),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceCreatedAtIdx: index("history_imports_workspace_created_at_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    activeWorkspaceUnique: uniqueIndex(
      "history_imports_active_workspace_unique",
    )
      .on(table.workspaceId)
      .where(sql`${table.status} IN ('pending', 'running')`),
    statusCheck: check(
      "history_imports_status_check",
      sql`${table.status} IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled')`,
    ),
    periodMonthsCheck: check(
      "history_imports_period_months_check",
      sql`${table.periodMonths} BETWEEN 1 AND 24`,
    ),
    maxPullRequestsCheck: check(
      "history_imports_max_pull_requests_check",
      sql`${table.maxPullRequests} BETWEEN 10 AND 200`,
    ),
  }),
);

/**
 * Per-workspace INPUT config (release version source, branch filters). Output/destination
 * config lives in `workspace_destinations`. Non-secret values only.
 */
export const workspaceSettingsTable = pgTable(
  "workspace_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id, {
      onDelete: "cascade",
    }),
    releaseInfoPlistPath: text("release_info_plist_path"),
    releaseVersionBranch: text("release_version_branch"),
    releaseMonitoredRepo: text("release_monitored_repo"),
    /**
     * Tipo de projeto para releases: `ios_plist`, `ios_pbx`, `react_native_expo`, `android_gradle`, `flutter_pubspec`.
     * Usar em conjunto com `release_version_file_path` (um único ficheiro onde a versão muda).
     */
    releaseProjectKind: text("release_project_kind"),
    /** Caminho no repo do ficheiro de versão (Info.plist, project.pbxproj, app.json, etc.). */
    releaseVersionFilePath: text("release_version_file_path"),
    releaseProjectPbxprojPath: text("release_project_pbxproj_path"),
    /**
     * Expo / React Native: repo-relative path to `app.json`, `app.config.json`, `app.config.js`, or `app.config.ts`.
     * When set, release version is read from this file instead of Info.plist / pbxproj.
     * Prefer `release_project_kind` + `release_version_file_path` for novos projetos.
     */
    releaseExpoAppConfigPath: text("release_expo_app_config_path"),
    releaseCompareRootSha: text("release_compare_root_sha"),
    /** Base branch names for PR summarization (`pull_request.base.ref`); empty means any branch. */
    prSummaryBaseBranches: jsonb("pr_summary_base_branches").$type<string[]>(),
    /**
     * Branch names that trigger direct-push summaries. Empty/null falls back to the repo
     * default branch (`workspaces.repo_default_branch`).
     */
    pushSummaryBranches: jsonb("push_summary_branches").$type<string[]>(),
    /** Paths/globs omitted before history is summarized. Empty explicitly disables defaults. */
    historyExcludedPaths: jsonb("history_excluded_paths").$type<string[]>(),
    /** GitHub actor logins omitted before history is summarized. */
    historyExcludedActors: jsonb("history_excluded_actors").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceIdUniqueWhenSet: uniqueIndex("workspace_settings_workspace_id_key")
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
  }),
);

/**
 * Canonical project versions used by the V1 timeline. Existing `releases` rows remain
 * source records until projection parity is proven.
 */
export const projectVersionsTable = pgTable(
  "project_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    displayVersion: text("display_version").notNull(),
    normalizedVersion: text("normalized_version").notNull(),
    buildVersion: text("build_version"),
    title: text("title"),
    changelog: text("changelog"),
    sections:
      jsonb("sections").$type<Array<{ label: string; items: string[] }>>(),
    promptVersion: integer("prompt_version"),
    status: text("status").notNull(),
    strategy: text("strategy").notNull(),
    sourceRef: text("source_ref").notNull(),
    sourceUrl: text("source_url"),
    sourceReleaseId: uuid("source_release_id").references(
      () => releasesTable.id,
      {
        onDelete: "set null",
      },
    ),
    previousVersionId: uuid("previous_version_id"),
    beforeSha: text("before_sha"),
    headSha: text("head_sha"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceSourceUnique: unique(
      "project_versions_workspace_strategy_source_unique",
    ).on(table.workspaceId, table.strategy, table.sourceRef),
    workspaceTimelineIdx: index("project_versions_workspace_timeline_idx").on(
      table.workspaceId,
      table.status,
      table.releasedAt,
      table.id,
    ),
    sourceReleaseIdIdx: index("project_versions_source_release_id_idx").on(
      table.sourceReleaseId,
    ),
    previousVersionIdIdx: index("project_versions_previous_version_id_idx").on(
      table.previousVersionId,
    ),
    previousVersionFk: foreignKey({
      columns: [table.previousVersionId],
      foreignColumns: [table.id],
      name: "project_versions_previous_version_id_fk",
    }).onDelete("set null"),
    statusCheck: check(
      "project_versions_status_check",
      sql`${table.status} IN ('released', 'in_development')`,
    ),
    strategyCheck: check(
      "project_versions_strategy_check",
      sql`${table.strategy} IN ('github_release', 'git_tag', 'version_file')`,
    ),
  }),
);

/** User-understandable units of change projected from PR, push, and release source records. */
export const changesTable = pgTable(
  "changes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").references(() => projectVersionsTable.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    summaryExecutive: text("summary_executive"),
    summaryTechnical: text("summary_technical"),
    category: text("category").notNull(),
    confidence: integer("confidence"),
    firstOccurredAt: timestamp("first_occurred_at", {
      withTimezone: true,
    }).notNull(),
    lastOccurredAt: timestamp("last_occurred_at", {
      withTimezone: true,
    }).notNull(),
    promptVersion: integer("prompt_version"),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceLastOccurredAtIdx: index(
      "changes_workspace_last_occurred_at_idx",
    ).on(table.workspaceId, table.lastOccurredAt),
    workspaceUnversionedTimelineIdx: index(
      "changes_workspace_unversioned_timeline_idx",
    )
      .on(table.workspaceId, table.lastOccurredAt, table.id)
      .where(sql`${table.versionId} IS NULL`),
    versionIdIdx: index("changes_version_id_idx").on(table.versionId),
    categoryCheck: check(
      "changes_category_check",
      sql`${table.category} IN ('feature', 'bugfix', 'refactor', 'chore', 'other')`,
    ),
    confidenceCheck: check(
      "changes_confidence_check",
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 100)`,
    ),
    occurrenceOrderCheck: check(
      "changes_occurrence_order_check",
      sql`${table.lastOccurredAt} >= ${table.firstOccurredAt}`,
    ),
  }),
);

/** Stable, workspace-owned identity for a feature or product-area evolution. */
export const changeLineagesTable = pgTable(
  "change_lineages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    source: text("source").notNull(),
    confidence: integer("confidence"),
    mergedIntoLineageId: uuid("merged_into_lineage_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceKeyUnique: unique("change_lineages_workspace_key_unique").on(
      table.workspaceId,
      table.key,
    ),
    workspaceStatusUpdatedIdx: index(
      "change_lineages_workspace_status_updated_idx",
    ).on(table.workspaceId, table.status, table.updatedAt),
    mergedIntoLineageIdIdx: index(
      "change_lineages_merged_into_lineage_id_idx",
    ).on(table.mergedIntoLineageId),
    mergedIntoLineageFk: foreignKey({
      columns: [table.mergedIntoLineageId],
      foreignColumns: [table.id],
      name: "change_lineages_merged_into_lineage_id_fk",
    }).onDelete("set null"),
    statusCheck: check(
      "change_lineages_status_check",
      sql`${table.status} IN ('active', 'removed', 'merged')`,
    ),
    sourceCheck: check(
      "change_lineages_source_check",
      sql`${table.source} IN ('rule', 'ai', 'human')`,
    ),
    confidenceCheck: check(
      "change_lineages_confidence_check",
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 100)`,
    ),
    mergedTargetCheck: check(
      "change_lineages_merged_target_check",
      sql`(${table.status} = 'merged' AND ${table.mergedIntoLineageId} IS NOT NULL) OR (${table.status} <> 'merged' AND ${table.mergedIntoLineageId} IS NULL)`,
    ),
  }),
);

/** Ordered, evidence-backed membership of canonical changes in a lineage. */
export const changeLineageEntriesTable = pgTable(
  "change_lineage_entries",
  {
    lineageId: uuid("lineage_id")
      .notNull()
      .references(() => changeLineagesTable.id, { onDelete: "cascade" }),
    changeId: uuid("change_id")
      .notNull()
      .references(() => changesTable.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    confidence: integer("confidence"),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lineageId, table.changeId] }),
    lineageTimelineIdx: index("change_lineage_entries_lineage_timeline_idx").on(
      table.lineageId,
      table.occurredAt,
      table.changeId,
    ),
    changeIdIdx: index("change_lineage_entries_change_id_idx").on(
      table.changeId,
    ),
    relationTypeCheck: check(
      "change_lineage_entries_relation_type_check",
      sql`${table.relationType} IN ('introduced', 'modified', 'fixed', 'removed', 'restored', 'other')`,
    ),
    sourceCheck: check(
      "change_lineage_entries_source_check",
      sql`${table.source} IN ('rule', 'ai', 'human')`,
    ),
    confidenceCheck: check(
      "change_lineage_entries_confidence_check",
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 100)`,
    ),
  }),
);

/** Claim-level provenance for a canonical change. */
export const changeEvidenceTable = pgTable(
  "change_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    changeId: uuid("change_id")
      .notNull()
      .references(() => changesTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    sourceKey: text("source_key").notNull(),
    externalId: text("external_id"),
    url: text("url"),
    sha: text("sha"),
    path: text("path"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    sourceRecordType: text("source_record_type"),
    sourceRecordId: uuid("source_record_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    changeSourceUnique: unique("change_evidence_change_source_unique").on(
      table.changeId,
      table.sourceKey,
    ),
    sourceKeyIdx: index("change_evidence_source_key_idx").on(table.sourceKey),
    sourceRecordIdx: index("change_evidence_source_record_idx")
      .on(table.sourceRecordType, table.sourceRecordId)
      .where(sql`${table.sourceRecordId} IS NOT NULL`),
    kindCheck: check(
      "change_evidence_kind_check",
      sql`${table.kind} IN ('pull_request', 'commit', 'file', 'compare', 'release', 'version_marker')`,
    ),
  }),
);

/** Stable workspace-owned product areas and their matching/exclusion rules. */
export const productAreasTable = pgTable(
  "product_areas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    rules: jsonb("rules").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceSlugUnique: unique("product_areas_workspace_slug_unique").on(
      table.workspaceId,
      table.slug,
    ),
  }),
);

/** Many-to-many relation between canonical changes and stable product areas. */
export const changeAreasTable = pgTable(
  "change_areas",
  {
    changeId: uuid("change_id")
      .notNull()
      .references(() => changesTable.id, { onDelete: "cascade" }),
    areaId: uuid("area_id")
      .notNull()
      .references(() => productAreasTable.id, { onDelete: "cascade" }),
    confidence: integer("confidence"),
    source: text("source").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.changeId, table.areaId] }),
    areaIdIdx: index("change_areas_area_id_idx").on(table.areaId),
    sourceCheck: check(
      "change_areas_source_check",
      sql`${table.source} IN ('rule', 'ai', 'human')`,
    ),
    confidenceCheck: check(
      "change_areas_confidence_check",
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 100)`,
    ),
  }),
);

/** Attribution with explicit collaboration roles; never a productivity score source. */
export const changeContributorsTable = pgTable(
  "change_contributors",
  {
    changeId: uuid("change_id")
      .notNull()
      .references(() => changesTable.id, { onDelete: "cascade" }),
    externalIdentity: text("external_identity").notNull(),
    displayName: text("display_name"),
    role: text("role").notNull(),
    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.changeId, table.externalIdentity, table.role],
    }),
    externalIdentityIdx: index("change_contributors_external_identity_idx").on(
      table.externalIdentity,
    ),
    roleCheck: check(
      "change_contributors_role_check",
      sql`${table.role} IN ('pr_author', 'commit_author', 'pusher', 'reviewer', 'coauthor')`,
    ),
  }),
);

/**
 * Per-workspace OUTPUT destinations (where summaries are published). One row per (workspace, type);
 * multiple types can be enabled at once (Notion + Slack + …). `type` is `notion` today.
 * `config` holds non-secret per-type config; `secret_ciphertext` holds the sealed OAuth/bot token.
 */
export const workspaceDestinationsTable = pgTable(
  "workspace_destinations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    /** Destination type: `notion` today; `slack`/`whatsapp` later. */
    type: text("type").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Non-secret per-type config. Notion:
     * `{ prDatabaseId, releasesDatabaseId, pushesDatabaseId, workspaceName }`.
     */
    config: jsonb("config").$type<Record<string, unknown>>(),
    /** Sealed (AES via AUTH_JWT_SECRET) provider token, e.g. Notion OAuth bot token. */
    secretCiphertext: text("secret_ciphertext"),
    /** Provider-side account id (e.g. Notion workspace id). */
    externalAccountId: text("external_account_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceTypeUnique: unique(
      "workspace_destinations_workspace_id_type_unique",
    ).on(table.workspaceId, table.type),
    workspaceIdIdx: index("workspace_destinations_workspace_id_idx").on(
      table.workspaceId,
    ),
  }),
);

export const promptsTable = pgTable(
  "prompts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    nameVersionUnique: unique("prompts_name_version_unique").on(
      table.name,
      table.version,
    ),
  }),
);

/**
 * Beta closed-waitlist signups captured by the public landing page
 * (`POST /api/whitelist`). One row per email (idempotent via the unique).
 */
export const whitelistSignupsTable = pgTable(
  "whitelist_signups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    team: text("team").notNull(),
    /** Self-reported dev-team size bucket (e.g. "1–5"). */
    teamSize: text("team_size"),
    /** Self-reported role (e.g. "Founder / CTO"). */
    role: text("role"),
    /** Optional GitHub org link the lead provided. */
    githubOrg: text("github_org"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    emailUnique: unique("whitelist_signups_email_unique").on(table.email),
  }),
);

/** Public landing-page early-access capture: email only (a later early-access
 *  action runs against these). Separate from whitelist_signups by design. */
export const earlyAccessSignupsTable = pgTable(
  "early_access_signups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    /** Landing language the lead used (e.g. "pt", "pt-BR"). */
    locale: text("locale"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    emailUnique: unique("early_access_signups_email_unique").on(table.email),
  }),
);
