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
  /**
   * Comma-separated browser origins allowed to call the HTTP API (e.g. the Vite dev server).
   * When empty, `NODE_ENV === "development"` enables reflective CORS for local UI work; production stays off unless you set explicit origins.
   */
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined) {
        return [] as string[];
      }
      const origins = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      return origins;
    }),
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
  /**
   * Modelo unificado (preferido): `ios_plist` | `ios_pbx` | `react_native_expo` | `android_gradle` | `flutter_pubspec`.
   * Exige `RELEASE_VERSION_FILE_PATH` na mesma origem (env ou DB).
   */
  RELEASE_PROJECT_KIND: z.string().min(1).optional(),
  /** Caminho no repo do ficheiro onde a versão é alterada (em conjunto com `RELEASE_PROJECT_KIND`). */
  RELEASE_VERSION_FILE_PATH: z.string().min(1).optional(),
  /**
   * Google OAuth (optional). When fully configured, the HTTP server exposes
   * `/auth/google/start` and `/auth/google/callback` for browser sign-in.
   */
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  /** HMAC secret for Driff session JWTs (min 32 chars when OAuth is enabled). */
  AUTH_JWT_SECRET: z.string().min(32).optional(),
  /** Public base URL of this API (e.g. http://localhost:3000) — used as Google redirect origin. */
  AUTH_PUBLIC_URL: z.string().url().optional(),
  /** Vite / web app origin where users return after OAuth (e.g. http://localhost:5173). */
  FRONTEND_URL: z.string().url().optional(),
}).superRefine((data, ctx) => {
  const oauthParts = [
    data.GOOGLE_OAUTH_CLIENT_ID,
    data.GOOGLE_OAUTH_CLIENT_SECRET,
    data.AUTH_JWT_SECRET,
    data.AUTH_PUBLIC_URL,
    data.FRONTEND_URL,
  ];
  const defined = oauthParts.filter((value) => value !== undefined && value !== "");
  if (defined.length === 0) {
    return;
  }
  if (defined.length !== oauthParts.length) {
    ctx.addIssue({
      code: "custom",
      message:
        "Google OAuth: set all of GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, AUTH_JWT_SECRET (min 32 chars), AUTH_PUBLIC_URL, and FRONTEND_URL, or omit all OAuth variables.",
    });
    return;
  }
  if (
    data.AUTH_PUBLIC_URL !== undefined &&
    data.FRONTEND_URL !== undefined &&
    data.AUTH_PUBLIC_URL.replace(/\/+$/, "") === data.FRONTEND_URL.replace(/\/+$/, "")
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "AUTH_PUBLIC_URL and FRONTEND_URL must differ: AUTH_PUBLIC_URL is the Fastify API (e.g. http://localhost:3000); FRONTEND_URL is the Vite app (e.g. http://localhost:5173).",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export const execute = (rawEnv: NodeJS.ProcessEnv = process.env): Env => {
  return envSchema.parse(rawEnv);
};
