import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const postgresClient = { end: vi.fn() };
  const drizzleDb = { query: {} };
  const postgresFactory = vi.fn(() => postgresClient);
  const drizzleFactory = vi.fn(() => drizzleDb);
  const envExecute = vi.fn(() => ({
    DATABASE_URL: "postgres://env-user:env-pass@localhost:5432/driff",
  }));

  return {
    drizzleDb,
    drizzleFactory,
    envExecute,
    postgresClient,
    postgresFactory,
  };
});

vi.mock("postgres", () => ({
  default: mocks.postgresFactory,
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: mocks.drizzleFactory,
}));

vi.mock("@/config/env.js", () => ({
  execute: mocks.envExecute,
}));

import { execute } from "@/db/client.js";

describe("db/client execute", () => {
  it("should create postgres and drizzle clients using input database url", () => {
    const databaseUrl = "postgres://input-user:input-pass@localhost:5432/driff";

    const result = execute({ databaseUrl });

    expect(mocks.postgresFactory).toHaveBeenCalledWith(databaseUrl);
    expect(mocks.drizzleFactory).toHaveBeenCalledWith(mocks.postgresClient, {
      schema: expect.any(Object),
    });
    expect(result.client).toBe(mocks.postgresClient);
    expect(result.db).toBe(mocks.drizzleDb);
  });

  it("should fallback to env database url when input is absent", () => {
    execute();

    expect(mocks.envExecute).toHaveBeenCalledOnce();
    expect(mocks.postgresFactory).toHaveBeenCalledWith(
      "postgres://env-user:env-pass@localhost:5432/driff",
    );
  });
});
