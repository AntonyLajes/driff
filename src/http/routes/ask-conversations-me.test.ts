import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AskConversationStore } from "@/ask/conversation-store.js";
import { signSessionJwt } from "@/auth/session-jwt.js";
import { handler } from "@/http/routes/ask-conversations-me.js";

const JWT_SECRET = "a".repeat(32);
const USER_ID = "00000000-0000-4000-8000-000000000099";
const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000aa";
const CONVERSATION_ID = "00000000-0000-4000-8000-0000000000ab";
const NOW = "2026-08-10T18:00:00.000Z";

const token = () =>
  signSessionJwt({
    secret: JWT_SECRET,
    userId: USER_ID,
    email: "user@example.com",
    expiresInSeconds: 3600,
  });

const conversation = {
  id: CONVERSATION_ID,
  title: "What changed?",
  messages: [{ id: "1", role: "user" as const, text: "What changed?" }],
  createdAt: NOW,
  updatedAt: NOW,
};

const buildStore = (): AskConversationStore => ({
  list: vi.fn(async () => [conversation]),
  upsert: vi.fn(async (input) => ({
    id: input.id,
    title: input.title,
    messages: input.messages,
    createdAt: NOW,
    updatedAt: NOW,
  })),
  remove: vi.fn(async () => true),
});

describe("http/routes/ask-conversations-me", () => {
  const servers: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  const setup = async (store = buildStore()) => {
    const server = fastify({ logger: false });
    servers.push(server);
    await handler(server, {
      db: {} as never,
      jwtSecret: JWT_SECRET,
      store,
      resolveWorkspace: vi.fn(async () => ({
        kind: "ok" as const,
        workspaceId: WORKSPACE_ID,
      })),
    });
    await server.ready();
    return { server, store };
  };

  it("should reject conversation reads without a bearer session", async () => {
    const { server } = await setup();
    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/ask/conversations",
    });
    expect(response.statusCode).toBe(401);
  });

  it("should list conversations for the session user and visible workspace", async () => {
    const { server, store } = await setup();
    const response = await server.inject({
      method: "GET",
      url: "/api/me/workspaces/by-slug/ride-pack/ask/conversations",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ conversations: [conversation] });
    expect(store.list).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    });
  });

  it("should validate and upsert a bounded conversation", async () => {
    const { server, store } = await setup();
    const response = await server.inject({
      method: "PUT",
      url: `/api/me/workspaces/by-slug/ride-pack/ask/conversations/${CONVERSATION_ID}`,
      headers: { authorization: `Bearer ${token()}` },
      payload: {
        title: " What changed? ",
        messages: conversation.messages,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().conversation.title).toBe("What changed?");
    expect(store.upsert).toHaveBeenCalledWith({
      id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      title: "What changed?",
      messages: conversation.messages,
    });
  });

  it("should reject transient chat messages", async () => {
    const { server, store } = await setup();
    const response = await server.inject({
      method: "PUT",
      url: `/api/me/workspaces/by-slug/ride-pack/ask/conversations/${CONVERSATION_ID}`,
      headers: { authorization: `Bearer ${token()}` },
      payload: {
        title: "What changed?",
        messages: [{ id: "1", role: "streaming", text: "partial" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("should delete only the session user's conversation", async () => {
    const { server, store } = await setup();
    const response = await server.inject({
      method: "DELETE",
      url: `/api/me/workspaces/by-slug/ride-pack/ask/conversations/${CONVERSATION_ID}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(204);
    expect(store.remove).toHaveBeenCalledWith({
      id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    });
  });
});
