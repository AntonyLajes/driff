import { execute as createServer } from "@/http/server.js";

export interface ServerLike {
  listen: (options: { port: number; host: string }) => Promise<string>;
}

export interface ExecuteInput {
  server?: ServerLike;
  port?: number;
  host?: string;
}

export const execute = async (
  input: ExecuteInput = {},
): Promise<{ address: string; server: ServerLike }> => {
  const server = input.server ?? createServer();
  const port = input.port ?? Number(process.env.PORT ?? 3000);
  const host = input.host ?? "0.0.0.0";
  const address = await server.listen({ port, host });

  return { address, server };
};

/* c8 ignore next 3 */
if (import.meta.url === `file://${process.argv[1]}`) {
  void execute();
}
