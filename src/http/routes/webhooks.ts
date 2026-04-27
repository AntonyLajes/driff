import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  type ProcessPrJobInput,
  type WebhookDependencies,
  type WebhookEventInput,
} from "@/http/routes/webhooks-dependencies.js";
import { execute as verifySignature } from "@/sources/github/verify.js";

const mergedPullRequestPayloadSchema = z.object({
  action: z.literal("closed"),
  repository: z.object({
    full_name: z.string().min(1),
  }),
  pull_request: z.object({
    merged: z.literal(true),
    number: z.number().int().positive(),
    base: z.object({
      ref: z.string().min(1),
    }),
  }),
});

interface HeaderInput {
  deliveryId: string;
  eventType: string;
  signatureHeader: string | undefined;
}

export interface HandlerInput extends WebhookDependencies {
  webhookSecret: string;
  /**
   * When set to a non-empty list, only merged PRs targeting one of these base branches
   * (`pull_request.base.ref`) are summarized. Omitted or `null` means any base branch.
   */
  prSummaryBaseBranches?: string[] | null;
}

const getHeaderValue = (value: string | string[] | undefined): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0];
  }

  return undefined;
};

const parseHeaders = (request: FastifyRequest): HeaderInput | null => {
  const deliveryId = getHeaderValue(request.headers["x-github-delivery"]);
  const eventType = getHeaderValue(request.headers["x-github-event"]);
  const signatureHeader = getHeaderValue(request.headers["x-hub-signature-256"]);

  if (!deliveryId || !eventType) {
    return null;
  }

  return {
    deliveryId,
    eventType,
    signatureHeader,
  };
};

const parsePayload = (body: unknown): Record<string, unknown> | null => {
  if (typeof body !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const shouldSummarizeByBaseBranch = (
  baseRef: string,
  allowedBranches: string[] | null | undefined,
): boolean => {
  if (allowedBranches === null || allowedBranches === undefined) {
    return true;
  }
  if (allowedBranches.length === 0) {
    return true;
  }
  return allowedBranches.includes(baseRef);
};

const buildProcessPrJobInput = (
  eventType: string,
  payload: Record<string, unknown>,
  prSummaryBaseBranches: string[] | null | undefined,
): ProcessPrJobInput | null => {
  if (eventType !== "pull_request") {
    return null;
  }

  const parsed = mergedPullRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  const baseRef = parsed.data.pull_request.base.ref;
  if (!shouldSummarizeByBaseBranch(baseRef, prSummaryBaseBranches)) {
    return null;
  }

  return {
    repo: parsed.data.repository.full_name,
    prNumber: parsed.data.pull_request.number,
  };
};

const buildWebhookEventInput = (
  headers: HeaderInput,
  payload: Record<string, unknown>,
): WebhookEventInput => {
  return {
    deliveryId: headers.deliveryId,
    eventType: headers.eventType,
    payload,
  };
};

export const execute = async (
  request: FastifyRequest,
  reply: FastifyReply,
  input: HandlerInput,
): Promise<void> => {
  const parsedHeaders = parseHeaders(request);
  if (!parsedHeaders) {
    reply.status(400).send({ error: "Missing required GitHub headers." });
    return;
  }

  const payload = parsePayload(request.body);
  if (!payload || typeof request.body !== "string") {
    reply.status(400).send({ error: "Invalid webhook payload." });
    return;
  }

  const isSignatureValid = verifySignature({
    payload: request.body,
    signatureHeader: parsedHeaders.signatureHeader,
    secret: input.webhookSecret,
  });

  if (!isSignatureValid) {
    reply.status(401).send({ error: "Invalid webhook signature." });
    return;
  }

  const isDuplicate = await input.findWebhookEventByDeliveryId(parsedHeaders.deliveryId);
  if (isDuplicate) {
    reply.status(200).send({ ok: true, duplicate: true });
    return;
  }

  await input.insertWebhookEvent(buildWebhookEventInput(parsedHeaders, payload));

  const processPrJobInput = buildProcessPrJobInput(
    parsedHeaders.eventType,
    payload,
    input.prSummaryBaseBranches,
  );
  if (processPrJobInput) {
    await input.enqueueProcessPrJob(processPrJobInput);
  }

  reply.status(200).send({ ok: true });
};

export const handler = async (
  server: FastifyInstance,
  input: HandlerInput,
): Promise<void> => {
  server.post("/webhooks/github", async (request, reply) => {
    await execute(request, reply, input);
  });
};
