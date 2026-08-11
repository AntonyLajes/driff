import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client.js";
import { askConversationsTable } from "@/db/schema.js";

const answerVersionSchema = z.object({
  answer: z.record(z.string(), z.unknown()),
  feedback: z.enum(["helpful", "unhelpful"]).optional(),
});

const userMessageSchema = z.object({
  id: z.string().trim().min(1).max(100),
  role: z.literal("user"),
  text: z.string().trim().min(1).max(500),
});

const assistantMessageSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    role: z.literal("assistant"),
    versions: z.array(answerVersionSchema).min(1).max(5),
    activeVersion: z.number().int().min(0).max(4),
  })
  .refine((message) => message.activeVersion < message.versions.length, {
    message: "activeVersion must reference an available answer version",
    path: ["activeVersion"],
  });

export const askConversationMessagesSchema = z
  .array(
    z.discriminatedUnion("role", [userMessageSchema, assistantMessageSchema]),
  )
  .max(20);

export const askConversationWriteSchema = z.object({
  title: z.string().trim().min(1).max(72),
  messages: askConversationMessagesSchema,
});

export type AskConversationMessage = z.infer<
  typeof askConversationMessagesSchema
>[number];

export interface AskConversation {
  id: string;
  title: string;
  messages: AskConversationMessage[];
  createdAt: string;
  updatedAt: string;
  sharedAt: string | null;
}

export interface AskConversationStore {
  list(input: {
    workspaceId: string;
    userId: string;
    limit?: number;
  }): Promise<AskConversation[]>;
  upsert(input: {
    id: string;
    workspaceId: string;
    userId: string;
    title: string;
    messages: AskConversationMessage[];
  }): Promise<AskConversation | null>;
  remove(input: {
    id: string;
    workspaceId: string;
    userId: string;
  }): Promise<boolean>;
  setShared(input: {
    id: string;
    workspaceId: string;
    userId: string;
    shared: boolean;
  }): Promise<AskConversation | null>;
  findShared(input: {
    id: string;
    workspaceId: string;
  }): Promise<AskConversation | null>;
}

const toConversation = (row: {
  id: string;
  title: string;
  messages: unknown;
  createdAt: Date;
  updatedAt: Date;
  sharedAt: Date | null;
}): AskConversation => ({
  id: row.id,
  title: row.title,
  messages: askConversationMessagesSchema.parse(row.messages),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  sharedAt: row.sharedAt?.toISOString() ?? null,
});

export interface ExecuteInput {
  db: Database;
}

export const execute = (input: ExecuteInput): AskConversationStore => ({
  list: async ({ workspaceId, userId, limit = 20 }) => {
    const rows = await input.db
      .select({
        id: askConversationsTable.id,
        title: askConversationsTable.title,
        messages: askConversationsTable.messages,
        createdAt: askConversationsTable.createdAt,
        updatedAt: askConversationsTable.updatedAt,
        sharedAt: askConversationsTable.sharedAt,
      })
      .from(askConversationsTable)
      .where(
        and(
          eq(askConversationsTable.workspaceId, workspaceId),
          eq(askConversationsTable.userId, userId),
        ),
      )
      .orderBy(desc(askConversationsTable.updatedAt))
      .limit(Math.min(Math.max(limit, 1), 20));
    return rows.map(toConversation);
  },
  upsert: async ({ id, workspaceId, userId, title, messages }) =>
    input.db.transaction(async (transaction) => {
      const now = new Date();
      await transaction
        .insert(askConversationsTable)
        .values({
          id,
          workspaceId,
          userId,
          title,
          messages,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: askConversationsTable.id });

      const rows = await transaction
        .update(askConversationsTable)
        .set({ title, messages, updatedAt: now })
        .where(
          and(
            eq(askConversationsTable.id, id),
            eq(askConversationsTable.workspaceId, workspaceId),
            eq(askConversationsTable.userId, userId),
          ),
        )
        .returning({
          id: askConversationsTable.id,
          title: askConversationsTable.title,
          messages: askConversationsTable.messages,
          createdAt: askConversationsTable.createdAt,
          updatedAt: askConversationsTable.updatedAt,
          sharedAt: askConversationsTable.sharedAt,
        });
      return rows[0] === undefined ? null : toConversation(rows[0]);
    }),
  remove: async ({ id, workspaceId, userId }) => {
    const rows = await input.db
      .delete(askConversationsTable)
      .where(
        and(
          eq(askConversationsTable.id, id),
          eq(askConversationsTable.workspaceId, workspaceId),
          eq(askConversationsTable.userId, userId),
        ),
      )
      .returning({ id: askConversationsTable.id });
    return rows[0] !== undefined;
  },
  setShared: async ({ id, workspaceId, userId, shared }) => {
    const now = new Date();
    const rows = await input.db
      .update(askConversationsTable)
      .set({ sharedAt: shared ? now : null, updatedAt: now })
      .where(
        and(
          eq(askConversationsTable.id, id),
          eq(askConversationsTable.workspaceId, workspaceId),
          eq(askConversationsTable.userId, userId),
        ),
      )
      .returning({
        id: askConversationsTable.id,
        title: askConversationsTable.title,
        messages: askConversationsTable.messages,
        createdAt: askConversationsTable.createdAt,
        updatedAt: askConversationsTable.updatedAt,
        sharedAt: askConversationsTable.sharedAt,
      });
    return rows[0] === undefined ? null : toConversation(rows[0]);
  },
  findShared: async ({ id, workspaceId }) => {
    const rows = await input.db
      .select({
        id: askConversationsTable.id,
        title: askConversationsTable.title,
        messages: askConversationsTable.messages,
        createdAt: askConversationsTable.createdAt,
        updatedAt: askConversationsTable.updatedAt,
        sharedAt: askConversationsTable.sharedAt,
      })
      .from(askConversationsTable)
      .where(
        and(
          eq(askConversationsTable.id, id),
          eq(askConversationsTable.workspaceId, workspaceId),
          isNotNull(askConversationsTable.sharedAt),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : toConversation(rows[0]);
  },
});
