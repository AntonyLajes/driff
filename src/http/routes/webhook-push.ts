import { z } from "zod";

import type { ProcessPushJobInput } from "@/http/routes/webhooks-dependencies.js";
import { refToBranch } from "@/http/routes/webhook-release.js";

const nullSha = (sha: string): boolean => /^0+$/.test(sha);

const pushPayloadSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  repository: z.object({ full_name: z.string() }),
  pusher: z.object({ name: z.string().optional() }).optional(),
  head_commit: z
    .object({
      timestamp: z.string().optional(),
    })
    .nullable()
    .optional(),
});

export interface PushWebhookConfig {
  /** Branch names that trigger push summaries. Empty falls back to {@link defaultBranch}. */
  branches: string[];
  /** Repo default branch, used when {@link branches} is empty. */
  defaultBranch: string | null;
  /** When set, only this `owner/name` repo triggers push summaries. */
  monitoredRepo: string | null;
}

const resolveAllowedBranches = (config: PushWebhookConfig): string[] => {
  const explicit = config.branches.map((b) => b.trim()).filter((b) => b.length > 0);
  if (explicit.length > 0) {
    return explicit;
  }
  const fallback = config.defaultBranch?.trim();
  return fallback && fallback.length > 0 ? [fallback] : [];
};

export const buildProcessPushJobInput = (
  eventType: string,
  payload: Record<string, unknown>,
  config: PushWebhookConfig | null | undefined,
): ProcessPushJobInput | null => {
  if (config === null || config === undefined) {
    return null;
  }
  if (eventType !== "push") {
    return null;
  }

  const parsed = pushPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  if (nullSha(data.after) || nullSha(data.before)) {
    return null;
  }
  if (data.before === data.after) {
    return null;
  }

  const repo = data.repository.full_name;
  if (config.monitoredRepo && config.monitoredRepo !== repo) {
    return null;
  }

  const branch = refToBranch(data.ref);
  if (branch === null) {
    return null;
  }
  const allowed = resolveAllowedBranches(config);
  if (allowed.length === 0 || !allowed.includes(branch)) {
    return null;
  }

  return {
    repo,
    beforeSha: data.before,
    afterSha: data.after,
    branch,
    pusher: data.pusher?.name ?? null,
    pushedAt: data.head_commit?.timestamp ?? null,
  };
};
