import { describe, expect, it } from "vitest";

import { isUniqueViolation, uniqueViolationConstraint } from "@/db/pg-error.js";

/** Mimics how drizzle-orm wraps the postgres-js error. */
const drizzleWrapped = (constraint: string) => ({
  name: "DrizzleQueryError",
  message: "Failed query: insert into ...",
  cause: {
    name: "PostgresError",
    code: "23505",
    constraint_name: constraint,
  },
});

describe("db/pg-error", () => {
  it("detects a unique violation on a bare postgres error", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("detects a unique violation nested in a DrizzleQueryError cause", () => {
    expect(isUniqueViolation(drizzleWrapped("teams_slug_unique"))).toBe(true);
  });

  it("is false for other / missing codes", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ cause: { code: "42P01" } })).toBe(false);
    expect(isUniqueViolation(new Error("nope"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it("returns the violated constraint name from the cause chain", () => {
    expect(uniqueViolationConstraint(drizzleWrapped("teams_slug_unique"))).toBe(
      "teams_slug_unique",
    );
    expect(
      uniqueViolationConstraint({ code: "23505", constraint: "workspaces_team_id_slug_unique" }),
    ).toBe("workspaces_team_id_slug_unique");
  });

  it("returns null when not a unique violation", () => {
    expect(uniqueViolationConstraint({ code: "23503" })).toBeNull();
  });
});
