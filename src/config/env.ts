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
});

export type Env = z.infer<typeof envSchema>;

export const execute = (rawEnv: NodeJS.ProcessEnv = process.env): Env => {
  return envSchema.parse(rawEnv);
};
