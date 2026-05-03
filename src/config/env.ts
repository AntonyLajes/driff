import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  NOTION_TOKEN: z.string().min(1),
  /**
   * Fallback when `workspace_settings.notion_pr_database_id` is unset.
   * Prefer storing the id in the database for non-secret integration config.
   */
  NOTION_DATABASE_ID: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PR_SUMMARY_BASE_BRANCHES: z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined) {
        return null;
      }
      const branches = raw
        .split(",")
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
      return branches.length === 0 ? null : branches;
    }),
  /** Fallback when `workspace_settings` does not define release Notion database id. */
  NOTION_RELEASES_DATABASE_ID: z.string().min(1).optional(),
  RELEASE_INFO_PLIST_PATH: z.string().min(1).optional(),
  RELEASE_VERSION_BRANCH: z.string().min(1).optional(),
  /** When set, only this `owner/name` repo triggers release notes (push handler). */
  RELEASE_MONITORED_REPO: z.string().min(1).optional(),
  /**
   * Optional: e.g. `MyApp.xcodeproj/project.pbxproj`. When set, version keys come from
   * MARKETING_VERSION / CURRENT_PROJECT_VERSION in this file (needed when Info.plist has $(...)).
   */
  RELEASE_PROJECT_PBXPROJ_PATH: z.string().min(1).optional(),
  /**
   * Optional Git SHA used as the left edge of the first GitHub compare on a marketing line
   * when no prior `releases` row exists for that `short_version` (see docs/release-compare-windows.md).
   */
  RELEASE_COMPARE_ROOT_SHA: z.string().min(1).optional(),
  /**
   * Expo / React Native: repo-relative path to `app.json`, `app.config.json`, `app.config.js`, or `app.config.ts`.
   */
  RELEASE_EXPO_APP_CONFIG_PATH: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export const execute = (rawEnv: NodeJS.ProcessEnv = process.env): Env => {
  return envSchema.parse(rawEnv);
};
