import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildEarlyAccessRegistrationInput,
  handler,
} from "@/http/routes/early-access.js";

const buildDb = (rows: Array<{ id: string }>) => {
  const returning = vi.fn(async () => rows);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as never, insert, values };
};

describe("http/routes/early-access", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  const register = async (rows: Array<{ id: string }>) => {
    const deps = buildDb(rows);
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, buildEarlyAccessRegistrationInput(deps.db));
    await server.ready();
    return { server, deps };
  };

  it("rejects malformed signups", async () => {
    const { server, deps } = await register([]);
    const response = await server.inject({
      method: "POST",
      url: "/api/early-access",
      payload: { email: "invalid" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_body" });
    expect(deps.insert).not.toHaveBeenCalled();
  });

  it("stores normalized signups and reports duplicates", async () => {
    const created = await register([{ id: "signup-id" }]);
    const response = await created.server.inject({
      method: "POST",
      url: "/api/early-access",
      payload: { email: " Antony@Example.com ", locale: " pt-BR " },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true, alreadyRegistered: false });
    expect(created.deps.values).toHaveBeenCalledWith({
      email: "antony@example.com",
      locale: "pt-BR",
    });

    const duplicate = await register([]);
    expect(
      (
        await duplicate.server.inject({
          method: "POST",
          url: "/api/early-access",
          payload: { email: "antony@example.com", locale: "" },
        })
      ).json(),
    ).toEqual({ ok: true, alreadyRegistered: true });
    expect(duplicate.deps.values).toHaveBeenCalledWith({
      email: "antony@example.com",
      locale: null,
    });
  });

  it("silently accepts honeypot submissions without persistence", async () => {
    const { server, deps } = await register([{ id: "unused" }]);
    const response = await server.inject({
      method: "POST",
      url: "/api/early-access",
      payload: { email: "bot@example.com", website: "https://spam.example" },
    });

    expect(response.json()).toEqual({ ok: true, alreadyRegistered: false });
    expect(deps.insert).not.toHaveBeenCalled();
  });
});
