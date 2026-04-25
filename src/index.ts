import { execute as createDbClient } from "@/db/client.js";
import { execute as createServer } from "@/http/server.js";
import { execute as createWebhookDependencies } from "@/http/routes/webhooks-dependencies.js";
import type { HandlerInput as WebhookHandlerInput } from "@/http/routes/webhooks.js";

export interface ServerLike {
  listen: (options: { port: number; host: string }) => Promise<string>;
}

export interface ExecuteInput {
  server?: ServerLike;
  port?: number;
  host?: string;
  webhook?: WebhookHandlerInput;
}

const buildWebhookInput = (
  input: ExecuteInput,
): WebhookHandlerInput | undefined => {
  if (input.webhook) {
    return input.webhook;
  }

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const databaseUrl = process.env.DATABASE_URL;

  if (!webhookSecret || !databaseUrl) {
    return undefined;
  }

  const { db } = createDbClient({ databaseUrl });
  return {
    webhookSecret,
    ...createWebhookDependencies({ db }),
  };
};

export const execute = async (
  input: ExecuteInput = {},
): Promise<{ address: string; server: ServerLike }> => {
  const server = input.server ?? createServer({ webhook: buildWebhookInput(input) });
  const port = input.port ?? Number(process.env.PORT ?? 3000);
  const host = input.host ?? "0.0.0.0";
  const address = await server.listen({ port, host });

  return { address, server };
};

/* c8 ignore next 3 */
if (import.meta.url === `file://${process.argv[1]}`) {
  void execute();
}
