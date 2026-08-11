import { describe, expect, it, vi } from "vitest";

import {
  askConversationMessagesSchema,
  execute,
} from "@/ask/conversation-store.js";

const CONVERSATION_ID = "00000000-0000-4000-8000-0000000000a1";
const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000a2";
const USER_ID = "00000000-0000-4000-8000-0000000000a3";
const now = new Date("2026-08-10T18:00:00.000Z");

const messages = [
  { id: "1", role: "user" as const, text: "What changed?" },
  {
    id: "2",
    role: "assistant" as const,
    versions: [{ answer: { answerText: "The Home screen changed." } }],
    activeVersion: 0,
  },
];

describe("ask/conversation-store", () => {
  it("should validate bounded messages and answer revisions", () => {
    expect(askConversationMessagesSchema.parse(messages)).toEqual(messages);
    expect(
      askConversationMessagesSchema.safeParse([
        {
          id: "2",
          role: "assistant",
          versions: [{ answer: {} }],
          activeVersion: 1,
        },
      ]).success,
    ).toBe(false);
  });

  it("should list only conversations returned by the scoped query", async () => {
    const limit = vi.fn(async () => [
      {
        id: CONVERSATION_ID,
        title: "What changed?",
        messages,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };

    const result = await execute({ db: db as never }).list({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    });

    expect(result).toEqual([
      {
        id: CONVERSATION_ID,
        title: "What changed?",
        messages,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ]);
    expect(limit).toHaveBeenCalledWith(20);
  });

  it("should upsert a conversation without replacing another owner's id", async () => {
    const onConflictDoNothing = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const setWhereReturning = vi.fn(async () => []);
    const updateWhere = vi.fn(() => ({ returning: setWhereReturning }));
    const set = vi.fn(() => ({ where: updateWhere }));
    const transaction = {
      insert: vi.fn(() => ({ values })),
      update: vi.fn(() => ({ set })),
    };
    const db = {
      transaction: vi.fn(
        async (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    };

    const result = await execute({ db: db as never }).upsert({
      id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      title: "What changed?",
      messages,
    });

    expect(result).toBeNull();
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
    expect(setWhereReturning).toHaveBeenCalledOnce();
  });

  it("should remove a conversation only when the scoped delete returns it", async () => {
    const returning = vi.fn(async () => [{ id: CONVERSATION_ID }]);
    const where = vi.fn(() => ({ returning }));
    const db = { delete: vi.fn(() => ({ where })) };

    const removed = await execute({ db: db as never }).remove({
      id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    });

    expect(removed).toBe(true);
  });
});
