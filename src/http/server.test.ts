import { afterEach, describe, expect, it } from "vitest";

import { execute } from "@/http/server.js";

describe("http/server execute", () => {
  const servers: ReturnType<typeof execute>[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("should expose health route on created server", async () => {
    const server = execute({ logger: false });
    servers.push(server);

    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("should create a server when logger is inferred in test environment", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "test";

      const server = execute();
      servers.push(server);

      await server.ready();
      const response = await server.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("should create a server when logger is inferred outside test environment", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousLogLevel = process.env.LOG_LEVEL;
    try {
      process.env.NODE_ENV = "production";
      process.env.LOG_LEVEL = "debug";

      const server = execute();
      servers.push(server);

      await server.ready();
      const response = await server.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      process.env.LOG_LEVEL = previousLogLevel;
    }
  });
});
