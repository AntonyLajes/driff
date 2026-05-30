import { sql } from "drizzle-orm";
import {
  boolean,
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userSlugUnique: unique("workspaces_user_id_slug_unique").on(table.userId, table.slug),
    userIdIdx: index("workspaces_user_id_idx").on(table.userId),
    // One workspace per linked repo, globally per provider (webhook routing is repo-keyed).
    providerRepoUnique: uniqueIndex("workspaces_provider_repo_unique")
      .on(table.sourceProvider, table.repoFullName)
      .where(sql`${table.repoFullName} IS NOT NULL`),
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
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id, { onDelete: "cascade" }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    workspaceIdUniqueWhenSet: uniqueIndex("workspace_settings_workspace_id_key")
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    workspaceTypeUnique: unique("workspace_destinations_workspace_id_type_unique").on(
      table.workspaceId,
      table.type,
    ),
    workspaceIdIdx: index("workspace_destinations_workspace_id_idx").on(table.workspaceId),
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
