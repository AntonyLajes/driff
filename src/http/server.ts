import sensible from "@fastify/sensible";
import fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { execute as registerCors, type CorsRegistrationInput } from "@/http/cors.js";
import {
  handler as registerAuthGoogleRoute,
  type GoogleOAuthRegistrationInput,
} from "@/http/routes/auth-google.js";
import {
  handler as registerHealthRoute,
  type HealthRouteInput,
} from "@/http/routes/health.js";
import {
  handler as registerGithubMeRoute,
  type GithubMeRegistrationInput,
} from "@/http/routes/github-me.js";
import {
  handler as registerDestinationsMeRoute,
  type DestinationsMeRegistrationInput,
} from "@/http/routes/destinations-me.js";
import {
  handler as registerMeStatsRoute,
  type MeStatsRegistrationInput,
} from "@/http/routes/me-stats.js";
import {
  handler as registerTeamsMeRoute,
  type TeamsMeRegistrationInput,
} from "@/http/routes/teams-me.js";
import {
  handler as registerTimelineMeRoute,
  type TimelineMeRegistrationInput,
} from "@/http/routes/timeline-me.js";
import {
  handler as registerWorkspacesMeRoute,
  type WorkspacesMeRegistrationInput,
} from "@/http/routes/workspaces-me.js";
import {
  handler as registerWebhookRoute,
  type HandlerInput as WebhookHandlerInput,
} from "@/http/routes/webhooks.js";
import {
  handler as registerWhitelistRoute,
  type WhitelistRegistrationInput,
} from "@/http/routes/whitelist.js";
import {
  handler as registerEarlyAccessRoute,
  type EarlyAccessRegistrationInput,
} from "@/http/routes/early-access.js";

export interface ExecuteInput {
  logger?: FastifyServerOptions["logger"];
  webhook?: WebhookHandlerInput;
  cors?: CorsRegistrationInput;
  /** When set, registers `/auth/google/start` and `/auth/google/callback`. */
  googleOAuth?: GoogleOAuthRegistrationInput;
  /** When set, registers `/api/me/workspaces` (Bearer session JWT). */
  workspacesMe?: WorkspacesMeRegistrationInput;
  /** When set, registers `/api/me/stats` and `/api/me/activity` (Bearer session JWT). */
  meStats?: MeStatsRegistrationInput;
  /** When set, registers `/api/me/teams` (Bearer session JWT). */
  teamsMe?: TeamsMeRegistrationInput;
  /** When set, registers the canonical workspace timeline (Bearer session JWT). */
  timelineMe?: TimelineMeRegistrationInput;
  /** When set, registers `/api/me/github/*` (GitHub user OAuth + repo helpers). */
  githubMe?: GithubMeRegistrationInput;
  /** When set, registers `/api/me/.../destinations/*` (Notion OAuth + destination config). */
  destinationsMe?: DestinationsMeRegistrationInput;
  /** When set, registers `GET /health/queue` (job-queue liveness for external monitors). */
  health?: HealthRouteInput;
  /** When set, registers the public `POST /api/whitelist` (landing-page beta signups). */
  whitelist?: WhitelistRegistrationInput;
  /** When set, registers the public `POST /api/early-access` (landing-page email capture). */
  earlyAccess?: EarlyAccessRegistrationInput;
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
    await registerHealthRoute(instance, input.health ?? {});
    if (input.googleOAuth !== undefined) {
      await registerAuthGoogleRoute(instance, input.googleOAuth);
    }
    if (input.workspacesMe !== undefined) {
      await registerWorkspacesMeRoute(instance, input.workspacesMe);
    }
    if (input.meStats !== undefined) {
      await registerMeStatsRoute(instance, input.meStats);
    }
    if (input.teamsMe !== undefined) {
      await registerTeamsMeRoute(instance, input.teamsMe);
    }
    if (input.timelineMe !== undefined) {
      await registerTimelineMeRoute(instance, input.timelineMe);
    }
    if (input.githubMe !== undefined) {
      await registerGithubMeRoute(instance, input.githubMe);
    }
    if (input.destinationsMe !== undefined) {
      await registerDestinationsMeRoute(instance, input.destinationsMe);
    }
    if (input.whitelist !== undefined) {
      await registerWhitelistRoute(instance, input.whitelist);
    }
    if (input.earlyAccess !== undefined) {
      await registerEarlyAccessRoute(instance, input.earlyAccess);
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
