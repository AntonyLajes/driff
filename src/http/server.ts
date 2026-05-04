import sensible from "@fastify/sensible";
import fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { execute as registerCors, type CorsRegistrationInput } from "@/http/cors.js";
import {
  handler as registerAuthGoogleRoute,
  type GoogleOAuthRegistrationInput,
} from "@/http/routes/auth-google.js";
import { handler as registerHealthRoute } from "@/http/routes/health.js";
import {
  handler as registerWebhookRoute,
  type HandlerInput as WebhookHandlerInput,
} from "@/http/routes/webhooks.js";

export interface ExecuteInput {
  logger?: FastifyServerOptions["logger"];
  webhook?: WebhookHandlerInput;
  cors?: CorsRegistrationInput;
  /** When set, registers `/auth/google/start` and `/auth/google/callback`. */
  googleOAuth?: GoogleOAuthRegistrationInput;
}

export const execute = (input: ExecuteInput = {}): FastifyInstance => {
  const server = fastify({
    logger:
      input.logger ??
      (process.env.NODE_ENV === "test"
        ? false
        : { level: process.env.LOG_LEVEL ?? "info" }),
  });

  server.register(sensible);
  server.register(async (instance) => {
    await registerCors(instance, input.cors ?? { kind: "off" });
    await registerHealthRoute(instance);
    if (input.googleOAuth !== undefined) {
      await registerAuthGoogleRoute(instance, input.googleOAuth);
    }
  });
  const webhookInput = input.webhook;
  if (webhookInput) {
    server.register(async (instance) => {
      instance.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        (_request, body, done) => {
          done(null, body);
        },
      );
      await registerWebhookRoute(instance, webhookInput);
    });
  }

  return server;
};
