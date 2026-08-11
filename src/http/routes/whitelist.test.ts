import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const { sendWhitelistEmailMock } = vi.hoisted(() => ({
  sendWhitelistEmailMock: vi.fn(async () => ({ sent: true })),
}));
vi.mock("@/email/send-whitelist-email.js", () => ({
  sendWhitelistEmail: sendWhitelistEmailMock,
}));

import { handler } from "@/http/routes/whitelist.js";

/** Minimal drizzle-insert chain stub: insert().values().onConflictDoNothing().returning(). */
const buildDb = (returningRows: Array<{ id: string }>) => {
  const returning = vi.fn(async () => returningRows);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as never, values, insert };
};

describe("http/routes/whitelist", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
    sendWhitelistEmailMock.mockClear();
  });

  const validBody = {
    name: "Antony Lajes",
    email: "Antony@Email.com",
    team: "SuperHealth",
    teamSize: "1–5",
    role: "Founder / CTO",
    githubOrg: "github.com/superhealth",
    releaseFrequency: "weekly",
    mainPain: "finding-when",
    messageVariant: "engineering-memory",
  };

  const register = async (returningRows: Array<{ id: string }>) => {
    const server = fastify({ logger: false });
    servers.push(server);
    const deps = buildDb(returningRows);
    await handler(server, {
      db: deps.db,
      resendApiKey: "key",
      resendFrom: "Driff <hi@driff.dev>",
    });
    await server.ready();
    return { server, deps };
  };

  it("returns 400 on an invalid body", async () => {
    const { server } = await register([{ id: "x" }]);
    const response = await server.inject({
      method: "POST",
      url: "/api/whitelist",
      payload: { name: "", email: "not-an-email", team: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_body" });
  });

  it("stores a new signup, lowercases the email, and sends the confirmation", async () => {
    const { server, deps } = await register([{ id: "row-1" }]);
    const response = await server.inject({
      method: "POST",
      url: "/api/whitelist",
      payload: validBody,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true, alreadyRegistered: false });
    expect(deps.values).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Antony Lajes",
        email: "antony@email.com",
        team: "SuperHealth",
        teamSize: "1–5",
        role: "Founder / CTO",
        githubOrg: "github.com/superhealth",
        releaseFrequency: "weekly",
        mainPain: "finding-when",
        messageVariant: "engineering-memory",
      }),
    );
    expect(sendWhitelistEmailMock).toHaveBeenCalledTimes(1);
    expect(sendWhitelistEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "Antony@Email.com", name: "Antony Lajes" }),
    );
  });

  it("is idempotent on a duplicate email and does not re-send the email", async () => {
    const { server } = await register([]);
    const response = await server.inject({
      method: "POST",
      url: "/api/whitelist",
      payload: validBody,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true, alreadyRegistered: true });
    expect(sendWhitelistEmailMock).not.toHaveBeenCalled();
  });

  it("normalizes optional empty fields to null", async () => {
    const { server, deps } = await register([{ id: "row-2" }]);
    await server.inject({
      method: "POST",
      url: "/api/whitelist",
      payload: { name: "Solo", email: "solo@dev.io", team: "Solo Co", githubOrg: "" },
    });
    expect(deps.values).toHaveBeenCalledWith(
      expect.objectContaining({
        teamSize: null,
        role: null,
        githubOrg: null,
        releaseFrequency: null,
        mainPain: null,
        messageVariant: null,
      }),
    );
  });

  it("silently drops honeypot submissions without storing or emailing", async () => {
    const { server, deps } = await register([{ id: "row-3" }]);
    const response = await server.inject({
      method: "POST",
      url: "/api/whitelist",
      payload: { ...validBody, website: "http://spam.example" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true, alreadyRegistered: false });
    expect(deps.insert).not.toHaveBeenCalled();
    expect(sendWhitelistEmailMock).not.toHaveBeenCalled();
  });
});
