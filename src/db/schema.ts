import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
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
 * GitHub OAuth (user-to-server) tokens for listing repos and reading public metadata.
 * Access tokens are stored sealed with `AUTH_JWT_SECRET` (see `token-aes.ts`).
 */
export const userGithubAccountsTable = pgTable("user_github_accounts", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  refreshTokenCiphertext: text("refresh_token_ciphertext"),
  scope: text("scope"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  githubUserId: text("github_user_id"),
  githubLogin: text("github_login"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

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
     * Optional app kind for onboarding / releases (`ios_plist`, `ios_pbx`, `react_native_expo`, …).
     * Null until detection or manual selection.
     */
    workspaceKind: text("workspace_kind"),
    /** Linked GitHub repo (`owner/name`) after onboarding. */
    githubRepoFullName: text("github_repo_full_name"),
    /** Default branch from GitHub metadata (optional cache). */
    githubRepoDefaultBranch: text("github_repo_default_branch"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userSlugUnique: unique("workspaces_user_id_slug_unique").on(table.userId, table.slug),
    userIdIdx: index("workspaces_user_id_idx").on(table.userId),
  }),
);

/**
 * Per-workspace integration config (Notion DB ids, release paths, filters), or a legacy
 * global row when `workspace_id` is null (worker continues to load only those until multi-tenant wiring).
 * Non-secret values only; secrets stay in environment variables.
 */
export const workspaceSettingsTable = pgTable(
  "workspace_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id, { onDelete: "cascade" }),
    notionPrDatabaseId: text("notion_pr_database_id"),
    notionReleasesDatabaseId: text("notion_releases_database_id"),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    workspaceIdUniqueWhenSet: uniqueIndex("workspace_settings_workspace_id_key")
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
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
