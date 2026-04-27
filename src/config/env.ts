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
});

export type Env = z.infer<typeof envSchema>;

export const execute = (rawEnv: NodeJS.ProcessEnv = process.env): Env => {
  return envSchema.parse(rawEnv);
};
