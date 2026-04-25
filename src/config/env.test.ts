import { describe, expect, it } from "vitest";

import { execute } from "@/config/env.js";

const buildValidEnv = () => ({
  DATABASE_URL: "postgres://user:pass@localhost:5432/driff",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
  ANTHROPIC_API_KEY: "anthropic-key",
  NOTION_TOKEN: "notion-token",
  NOTION_DATABASE_ID: "notion-database-id",
});

describe("config/env execute", () => {
  it("should parse valid environment values", () => {
    const result = execute(buildValidEnv());

    expect(result.DATABASE_URL).toBe("postgres://user:pass@localhost:5432/driff");
    expect(result.PORT).toBe(3000);
    expect(result.LOG_LEVEL).toBe("info");
    expect(result.NODE_ENV).toBe("development");
  });

  it("should throw when a required value is missing", () => {
    const { GITHUB_WEBHOOK_SECRET: _, ...invalidEnv } = buildValidEnv();

    expect(() => execute(invalidEnv)).toThrowError();
  });

  it("should throw when DATABASE_URL is invalid", () => {
    const invalidEnv = {
      ...buildValidEnv(),
      DATABASE_URL: "not-a-url",
    };

    expect(() => execute(invalidEnv)).toThrowError();
  });
});
