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

  it("should parse PR_SUMMARY_BASE_BRANCHES as a trimmed comma-separated list", () => {
    const result = execute({
      ...buildValidEnv(),
      PR_SUMMARY_BASE_BRANCHES: " develop , release",
    });

    expect(result.PR_SUMMARY_BASE_BRANCHES).toEqual(["develop", "release"]);
  });

  it("should return null for PR_SUMMARY_BASE_BRANCHES when empty or only whitespace", () => {
    const unset = execute({ ...buildValidEnv() });
    expect(unset.PR_SUMMARY_BASE_BRANCHES).toBeNull();

    const empty = execute({ ...buildValidEnv(), PR_SUMMARY_BASE_BRANCHES: "" });
    expect(empty.PR_SUMMARY_BASE_BRANCHES).toBeNull();

    const onlyCommas = execute({ ...buildValidEnv(), PR_SUMMARY_BASE_BRANCHES: " ,  , " });
    expect(onlyCommas.PR_SUMMARY_BASE_BRANCHES).toBeNull();
  });

  it("should parse optional RELEASE_COMPARE_ROOT_SHA", () => {
    const sha = "a".repeat(40);
    const result = execute({
      ...buildValidEnv(),
      RELEASE_COMPARE_ROOT_SHA: sha,
    });
    expect(result.RELEASE_COMPARE_ROOT_SHA).toBe(sha);
  });

  it("should allow omitting NOTION_DATABASE_ID at parse time", () => {
    const { NOTION_DATABASE_ID: _, ...rest } = buildValidEnv();
    const result = execute(rest);
    expect(result.NOTION_DATABASE_ID).toBeUndefined();
  });

  it("should parse CORS_ORIGINS as a trimmed comma-separated list", () => {
    const result = execute({
      ...buildValidEnv(),
      CORS_ORIGINS: " http://a.test ,http://b.test ",
    });

    expect(result.CORS_ORIGINS).toEqual(["http://a.test", "http://b.test"]);
  });

  it("should default CORS_ORIGINS to an empty list when unset", () => {
    const result = execute(buildValidEnv());
    expect(result.CORS_ORIGINS).toEqual([]);
  });

  it("should reject partial Google OAuth configuration", () => {
    expect(() =>
      execute({
        ...buildValidEnv(),
        GOOGLE_OAUTH_CLIENT_ID: "abc.apps.googleusercontent.com",
      }),
    ).toThrowError();
  });

  it("should parse full Google OAuth configuration", () => {
    const result = execute({
      ...buildValidEnv(),
      GOOGLE_OAUTH_CLIENT_ID: "abc.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
      AUTH_JWT_SECRET: "y".repeat(32),
      AUTH_PUBLIC_URL: "http://localhost:3000",
      FRONTEND_URL: "http://localhost:5173",
    });

    expect(result.GOOGLE_OAUTH_CLIENT_ID).toBe("abc.apps.googleusercontent.com");
    expect(result.AUTH_JWT_SECRET).toHaveLength(32);
    expect(result.FRONTEND_URL).toBe("http://localhost:5173");
  });
});
