import { createHmac } from "node:crypto";

import { execute as parseScenario } from "@/lab/scenario.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const WEBHOOK_PATH = "/webhooks/github";

export interface ReplayHttpResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export type ReplayFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<ReplayHttpResponse>;

export interface ExecuteInput {
  scenario: unknown;
  targetUrl: string;
  webhookSecret: string;
  allowedRemoteHosts?: readonly string[];
  confirmDevelopment?: boolean;
  fetcher?: ReplayFetch;
  sleeper?: (durationMs: number) => Promise<void>;
}

export interface ReplayResult {
  scenarioId: string;
  events: Array<{
    deliveryId: string;
    eventType: string;
    status: number;
  }>;
}

const normalizeAllowedHosts = (hosts: readonly string[]): Set<string> =>
  new Set(
    hosts
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
  );

const validateTarget = (
  rawTargetUrl: string,
  allowedRemoteHosts: readonly string[],
  confirmDevelopment: boolean,
): URL => {
  const target = new URL(rawTargetUrl);

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Driff Lab target must use http or https.");
  }
  if (target.username.length > 0 || target.password.length > 0) {
    throw new Error("Driff Lab target must not contain URL credentials.");
  }
  if (
    target.pathname !== WEBHOOK_PATH ||
    target.search.length > 0 ||
    target.hash.length > 0
  ) {
    throw new Error(
      `Driff Lab target must be the exact ${WEBHOOK_PATH} endpoint.`,
    );
  }

  const hostname = target.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(hostname)) {
    return target;
  }

  const allowedHosts = normalizeAllowedHosts(allowedRemoteHosts);
  if (!confirmDevelopment) {
    throw new Error("Remote Driff Lab replay requires --confirm-development.");
  }
  if (!allowedHosts.has(hostname)) {
    throw new Error(`Remote Driff Lab host is not allowlisted: ${hostname}`);
  }

  return target;
};

const defaultSleeper = async (durationMs: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });

const defaultFetcher: ReplayFetch = async (url, init) => fetch(url, init);

const signatureFor = (body: string, webhookSecret: string): string =>
  `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;

export const execute = async (input: ExecuteInput): Promise<ReplayResult> => {
  const scenario = parseScenario(input.scenario);
  const webhookSecret = input.webhookSecret.trim();
  if (webhookSecret.length === 0) {
    throw new Error("Driff Lab requires a non-empty GitHub webhook secret.");
  }

  const target = validateTarget(
    input.targetUrl,
    input.allowedRemoteHosts ?? [],
    input.confirmDevelopment ?? false,
  );
  const fetcher = input.fetcher ?? defaultFetcher;
  const sleeper = input.sleeper ?? defaultSleeper;
  const replayed: ReplayResult["events"] = [];
  let previousOffsetMs = 0;

  for (const event of scenario.events) {
    const delayMs = event.offsetMs - previousOffsetMs;
    if (delayMs > 0) {
      await sleeper(delayMs);
    }
    previousOffsetMs = event.offsetMs;

    const body = JSON.stringify(event.payload);
    let response: ReplayHttpResponse;
    try {
      response = await fetcher(target.href, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": event.deliveryId,
          "x-github-event": event.eventType,
          "x-hub-signature-256": signatureFor(body, webhookSecret),
        },
        body,
      });
    } catch (error) {
      throw new Error(`Driff Lab request failed for ${event.deliveryId}.`, {
        cause: error,
      });
    }

    if (!response.ok) {
      const responseBody = (await response.text()).slice(0, 1_000);
      throw new Error(
        `Driff Lab event ${event.deliveryId} failed with HTTP ${response.status}: ${responseBody}`,
      );
    }

    replayed.push({
      deliveryId: event.deliveryId,
      eventType: event.eventType,
      status: response.status,
    });
  }

  return { scenarioId: scenario.id, events: replayed };
};
