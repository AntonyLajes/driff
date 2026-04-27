import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  NOTION_TOKEN: z.string().min(1),
  NOTION_DATABASE_ID: z.string().min(1),
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
  NOTION_RELEASES_DATABASE_ID: z.string().min(1).optional(),
  RELEASE_INFO_PLIST_PATH: z.string().min(1).optional(),
  RELEASE_VERSION_BRANCH: z.string().min(1).optional(),
  /** When set, only this `owner/name` repo triggers release notes (push handler). */
  RELEASE_MONITORED_REPO: z.string().min(1).optional(),
})
  .superRefine((data, ctx) => {
    const hasReleasesDb = Boolean(data.NOTION_RELEASES_DATABASE_ID);
    if (!hasReleasesDb) {
      return;
    }
    if (!data.RELEASE_INFO_PLIST_PATH) {
      ctx.addIssue({
        code: "custom",
        message:
          "When NOTION_RELEASES_DATABASE_ID is set, RELEASE_INFO_PLIST_PATH is required (path to Info.plist in the app repo).",
        path: ["RELEASE_INFO_PLIST_PATH"],
      });
    }
    if (!data.RELEASE_VERSION_BRANCH) {
      ctx.addIssue({
        code: "custom",
        message:
          "When NOTION_RELEASES_DATABASE_ID is set, RELEASE_VERSION_BRANCH is required (e.g. develop).",
        path: ["RELEASE_VERSION_BRANCH"],
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export const execute = (rawEnv: NodeJS.ProcessEnv = process.env): Env => {
  return envSchema.parse(rawEnv);
};
