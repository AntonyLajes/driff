import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { buildProcessReleaseJobInput, type ReleaseWebhookConfig } from "@/http/routes/webhook-release.js";
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

export interface WebhookEnqueueSettings {
  prSummaryBaseBranches: string[] | null;
  releaseConfig: ReleaseWebhookConfig | null;
}

export interface HandlerInput extends WebhookDependencies {
  webhookSecret: string;
  /**
   * When set, branch filters and release enqueue rules follow the workspace linked to the
   * webhook repository (then global `workspace_settings` + env).
   */
  resolveWebhookSettings?: (repoFullName: string) => Promise<WebhookEnqueueSettings>;
  /**
   * When set to a non-empty list, only merged PRs targeting one of these base branches
   * (`pull_request.base.ref`) are summarized. Omitted or `null` means any base branch.
   * @deprecated Prefer `resolveWebhookSettings` for per-repo workspace settings.
   */
  prSummaryBaseBranches?: string[] | null;
  /**
   * When set, a `push` to `branch` that touches the plist can enqueue `process_release`.
   * @deprecated Prefer `resolveWebhookSettings` for per-repo workspace settings.
   */
  releaseConfig?: ReleaseWebhookConfig | null;
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

export const extractRepositoryFullName = (payload: Record<string, unknown>): string | null => {
  const repository = payload.repository;
  if (repository === null || typeof repository !== "object") {
    return null;
  }
  const fullName = (repository as Record<string, unknown>).full_name;
  return typeof fullName === "string" && fullName.trim().length > 0 ? fullName.trim() : null;
};

export const getProcessPrSkipReason = (
  eventType: string,
  payload: Record<string, unknown>,
  prSummaryBaseBranches: string[] | null | undefined,
): string | null => {
  if (eventType !== "pull_request") {
    return null;
  }

  const parsed = mergedPullRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return "pull_request_not_merged_close";
  }

  const baseRef = parsed.data.pull_request.base.ref;
  if (!shouldSummarizeByBaseBranch(baseRef, prSummaryBaseBranches)) {
    const allowed =
      prSummaryBaseBranches === null || prSummaryBaseBranches === undefined
        ? "any"
        : prSummaryBaseBranches.join(",");
    return `base_branch_filtered:${baseRef}:allowed=${allowed}`;
  }

  return null;
};

const buildProcessPrJobInput = (
  eventType: string,
  payload: Record<string, unknown>,
  prSummaryBaseBranches: string[] | null | undefined,
): ProcessPrJobInput | null => {
  if (eventType !== "pull_request") {
    return null;
  }

  if (getProcessPrSkipReason(eventType, payload, prSummaryBaseBranches) !== null) {
    return null;
  }

  const parsed = mergedPullRequestPayloadSchema.parse(payload);
  return {
    repo: parsed.repository.full_name,
    prNumber: parsed.pull_request.number,
  };
};

const resolveEnqueueSettings = async (
  input: HandlerInput,
  payload: Record<string, unknown>,
): Promise<WebhookEnqueueSettings> => {
  const repoFullName = extractRepositoryFullName(payload);
  if (repoFullName && input.resolveWebhookSettings) {
    return input.resolveWebhookSettings(repoFullName);
  }

  return {
    prSummaryBaseBranches: input.prSummaryBaseBranches ?? null,
    releaseConfig: input.releaseConfig ?? null,
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

  const enqueueSettings = await resolveEnqueueSettings(input, payload);
  const repoFullName = extractRepositoryFullName(payload);

  const processPrJobInput = buildProcessPrJobInput(
    parsedHeaders.eventType,
    payload,
    enqueueSettings.prSummaryBaseBranches,
  );
  if (processPrJobInput) {
    await input.enqueueProcessPrJob(processPrJobInput);
  } else {
    const skipReason = getProcessPrSkipReason(
      parsedHeaders.eventType,
      payload,
      enqueueSettings.prSummaryBaseBranches,
    );
    if (skipReason !== null) {
      request.log?.warn?.(
        { repo: repoFullName, skipReason, eventType: parsedHeaders.eventType },
        "webhook skipped process_pr enqueue",
      );
    }
  }

  const processReleaseInput = buildProcessReleaseJobInput(
    parsedHeaders.eventType,
    payload,
    enqueueSettings.releaseConfig,
  );
  if (processReleaseInput) {
    await input.enqueueProcessReleaseJob(processReleaseInput);
  } else if (parsedHeaders.eventType === "push" && enqueueSettings.releaseConfig) {
    const branch = typeof payload.ref === "string" ? payload.ref : null;
    request.log?.warn?.(
      {
        repo: repoFullName,
        ref: branch,
        releaseBranch: enqueueSettings.releaseConfig.branch,
        versionPaths: enqueueSettings.releaseConfig.versionWatchPaths,
      },
      "webhook skipped process_release enqueue",
    );
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
