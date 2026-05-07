import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { execute } from "@/http/cors.js";

describe("http/cors execute", () => {
  const servers: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("should attach reflective CORS so browser preflight receives allow-origin", async () => {
    const server = Fastify({ logger: false });
    servers.push(server);

    await execute(server, { kind: "reflect" });
    server.get("/probe", async () => ({ ok: true }));
    await server.ready();

    const response = await server.inject({
      method: "OPTIONS",
      url: "/probe",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
  });

  it("should allow DELETE on preflight so disconnect-style API calls work", async () => {
    const server = Fastify({ logger: false });
    servers.push(server);

    await execute(server, { kind: "reflect" });
    server.delete("/probe", async () => ({ ok: true }));
    await server.ready();

    const response = await server.inject({
      method: "OPTIONS",
      url: "/probe",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "authorization",
      },
    });

    expect(response.statusCode).toBe(204);
    const allowMethods = response.headers["access-control-allow-methods"];
    expect(allowMethods).toBeDefined();
    expect(String(allowMethods)).toContain("DELETE");
  });

  it("should allow only listed origins when using allowlist mode", async () => {
    const server = Fastify({ logger: false });
    servers.push(server);

    await execute(server, {
      kind: "allowlist",
      origins: ["http://localhost:5173"],
    });
    server.get("/probe", async () => ({ ok: true }));
    await server.ready();

    const allowed = await server.inject({
      method: "OPTIONS",
      url: "/probe",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });

    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );

    const denied = await server.inject({
      method: "OPTIONS",
      url: "/probe",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
      },
    });

    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
