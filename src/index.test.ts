import { describe, expect, it, vi } from "vitest";

import { execute } from "@/index.js";

describe("index execute", () => {
  it("should call listen with default host and port", async () => {
    const listen = vi.fn(async () => "http://0.0.0.0:3000");
    const server = { listen };

    const result = await execute({ server });

    expect(listen).toHaveBeenCalledWith({
      port: 3000,
      host: "0.0.0.0",
    });
    expect(result.address).toBe("http://0.0.0.0:3000");
    expect(result.server).toBe(server);
  });

  it("should call listen with custom host and port", async () => {
    const listen = vi.fn(async () => "http://127.0.0.1:4000");
    const server = { listen };

    const result = await execute({
      server,
      host: "127.0.0.1",
      port: 4000,
    });

    expect(listen).toHaveBeenCalledWith({
      port: 4000,
      host: "127.0.0.1",
    });
    expect(result.address).toBe("http://127.0.0.1:4000");
  });
});
