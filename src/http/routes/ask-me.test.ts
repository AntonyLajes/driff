import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signSessionJwt } from "@/auth/session-jwt.js";
import { execute as registerCors } from "@/http/cors.js";
import { handler } from "@/http/routes/ask-me.js";

const JWT_SECRET = "a".repeat(32);
const USER_ID = "00000000-0000-4000-8000-000000000099";
const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000aa";
const INTERACTION_ID = "00000000-0000-4000-8000-0000000000ab";

const token = () =>
  signSessionJwt({
    secret: JWT_SECRET,
    userId: USER_ID,
    email: "user@example.com",
    expiresInSeconds: 3600,
  });

const buildWorkspaceDb = (rows: unknown[]) => {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as never, select };
};

describe("http/routes/ask-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("should reject questions without a bearer session", async () => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db: {} as never, jwtSecret: JWT_SECRET });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/ask",
      payload: { question: "What changed?" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should scope a valid question to the workspace and acting team", async () => {
    const workspaceDb = buildWorkspaceDb([
      {
        id: WORKSPACE_ID,
        name: "ride-pack",
        slug: "ride-pack",
        repoFullName: "AntonyLajes/ride-pack",
      },
    ]);
    const historySearcher = vi.fn(async () => ({
      status: "no_evidence" as const,
      mode: "change" as const,
      confidence: "none" as const,
      queryTerms: ["checkout"],
      period: null,
      totalMatches: 0,
      hasMore: false,
      version: null,
      matches: [],
    }));
    const answerComposer = vi.fn(async () => ({
      answerText: "Não encontrei evidências sobre o botão de checkout.",
      usage: { model: "test-model", inputTokens: 120, outputTokens: 24 },
    }));
    const usageRecorder = vi.fn(async () => undefined);
    const interactionRecorder = vi.fn(async () => INTERACTION_ID);
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      historySearcher,
      answerComposer,
      usageRecorder,
      interactionRecorder,
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/ask",
      headers: { authorization: `Bearer ${token()}` },
      payload: {
        question: "  checkout button  ",
        conversation: [
          { role: "user", content: "  What changed recently?  " },
          { role: "assistant", content: "The Home changed." },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        workspace: { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
        question: "checkout button",
        intent: "history",
        answerText: "Não encontrei evidências sobre o botão de checkout.",
        interactionId: INTERACTION_ID,
        status: "no_evidence",
      }),
    );
    expect(historySearcher).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        question: "checkout button",
      }),
    );
    expect(interactionRecorder).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      hadEvidence: false,
    });
    expect(answerComposer).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "checkout button",
        conversation: [
          { role: "user", content: "What changed recently?" },
          { role: "assistant", content: "The Home changed." },
        ],
      }),
    );
    expect(usageRecorder).toHaveBeenCalledWith({
      repo: "AntonyLajes/ride-pack",
      usage: { model: "test-model", inputTokens: 120, outputTokens: 24 },
    });
  });

  it("should keep retrieval available when conversational composition fails", async () => {
    const workspaceDb = buildWorkspaceDb([
      {
        id: WORKSPACE_ID,
        name: "ride-pack",
        slug: "ride-pack",
        repoFullName: "AntonyLajes/ride-pack",
      },
    ]);
    const historySearcher = vi.fn(async () => ({
      status: "no_evidence" as const,
      mode: "change" as const,
      confidence: "none" as const,
      queryTerms: [],
      period: null,
      totalMatches: 0,
      hasMore: false,
      version: null,
      matches: [],
    }));
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      historySearcher,
      answerComposer: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
      interactionRecorder: vi.fn(async () => null),
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/ask",
      headers: { authorization: `Bearer ${token()}` },
      payload: { question: "What changed?" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({ status: "no_evidence", answerText: null }),
    );
  });

  it("should stream answer deltas before the final cited response", async () => {
    const workspaceDb = buildWorkspaceDb([
      {
        id: WORKSPACE_ID,
        name: "ride-pack",
        slug: "ride-pack",
        repoFullName: "AntonyLajes/ride-pack",
      },
    ]);
    const retrieval = {
      status: "no_evidence" as const,
      mode: "change" as const,
      confidence: "none" as const,
      queryTerms: ["checkout"],
      period: null,
      totalMatches: 0,
      hasMore: false,
      version: null,
      matches: [],
    };
    const answerStreamer = vi.fn(async ({ onText }) => {
      onText("Não encontrei ");
      onText("essa mudança.");
      return {
        answerText: "Não encontrei essa mudança.",
        usage: { model: "test-model", inputTokens: 90, outputTokens: 12 },
      };
    });
    const usageRecorder = vi.fn(async () => undefined);
    const interactionRecorder = vi.fn(async () => INTERACTION_ID);
    const server = fastify({ logger: false });
    servers.push(server);
    await registerCors(server, { kind: "reflect" });
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      historySearcher: vi.fn(async () => retrieval),
      answerStreamer,
      usageRecorder,
      interactionRecorder,
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/ask",
      headers: {
        authorization: `Bearer ${token()}`,
        accept: "text/event-stream",
        origin: "https://driff-web-development.up.railway.app",
      },
      payload: { question: "O checkout mudou?" },
    });
    const events = response.body
      .trim()
      .split("\n\n")
      .map(
        (entry) =>
          JSON.parse(entry.replace(/^data: /, "")) as Record<string, unknown>,
      );

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://driff-web-development.up.railway.app",
    );
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "delta",
      "delta",
      "done",
    ]);
    expect(events[1]).toEqual({ type: "delta", text: "Não encontrei " });
    expect(events[3]).toEqual(
      expect.objectContaining({
        type: "done",
        answer: expect.objectContaining({
          answerText: "Não encontrei essa mudança.",
          interactionId: INTERACTION_ID,
          status: "no_evidence",
        }),
      }),
    );
    expect(usageRecorder).toHaveBeenCalledOnce();
    expect(interactionRecorder).toHaveBeenCalledOnce();
  });

  it("should answer a greeting without searching or attaching evidence", async () => {
    const workspaceDb = buildWorkspaceDb([
      {
        id: WORKSPACE_ID,
        name: "ride-pack",
        slug: "ride-pack",
        repoFullName: "AntonyLajes/ride-pack",
      },
    ]);
    const historySearcher = vi.fn();
    const answerComposer = vi.fn();
    const usageRecorder = vi.fn();
    const interactionRecorder = vi.fn();
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      historySearcher,
      answerComposer,
      usageRecorder,
      interactionRecorder,
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/ask",
      headers: { authorization: `Bearer ${token()}` },
      payload: { question: "Oi" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workspace: { id: WORKSPACE_ID, name: "ride-pack", slug: "ride-pack" },
      question: "Oi",
      intent: "conversation",
      answerText:
        "Olá! Como posso ajudar? Você pode me perguntar sobre mudanças, versões, funcionalidades e participantes deste projeto.",
      interactionId: null,
      status: "no_evidence",
      mode: "change",
      confidence: "none",
      queryTerms: [],
      period: null,
      totalMatches: 0,
      hasMore: false,
      version: null,
      matches: [],
    });
    expect(historySearcher).not.toHaveBeenCalled();
    expect(answerComposer).not.toHaveBeenCalled();
    expect(usageRecorder).not.toHaveBeenCalled();
    expect(interactionRecorder).not.toHaveBeenCalled();
  });

  it("should update feedback only for an interaction in the acting workspace", async () => {
    const { db: workspaceDb } = buildWorkspaceDb([{ id: WORKSPACE_ID }]);
    const returning = vi.fn(async () => [{ id: INTERACTION_ID }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const db = { ...(workspaceDb as object), update } as never;
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, { db, jwtSecret: JWT_SECRET });
    await server.ready();

    const response = await server.inject({
      method: "PATCH",
      url: `/api/me/workspaces/by-slug/ride-pack/ask/${INTERACTION_ID}/feedback`,
      headers: { authorization: `Bearer ${token()}` },
      payload: { value: "helpful" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ feedback: "helpful" });
    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        feedback: "helpful",
        feedbackAt: expect.any(Date),
      }),
    );
  });

  it("should reject questions outside the accepted contract", async () => {
    const workspaceDb = buildWorkspaceDb([]);
    const historySearcher = vi.fn();
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: workspaceDb.db,
      jwtSecret: JWT_SECRET,
      historySearcher,
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/me/workspaces/by-slug/ride-pack/ask",
      headers: { authorization: `Bearer ${token()}` },
      payload: { question: "?" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_ask_question" });
    expect(workspaceDb.select).not.toHaveBeenCalled();
    expect(historySearcher).not.toHaveBeenCalled();
  });
});
