import { and, eq } from "drizzle-orm";

import { execute as buildCanonicalId } from "@/changes/canonical-id.js";
import type { Database } from "@/db/client.js";
import {
  changeLineageEntriesTable,
  changeLineagesTable,
  changesTable,
} from "@/db/schema.js";

export type LineageRelationType =
  | "introduced"
  | "modified"
  | "fixed"
  | "removed"
  | "restored"
  | "other";

export type LineageAssignmentSource = "rule" | "ai" | "human";

export interface ExecuteInput {
  db: Database;
  workspaceId: string;
  changeId: string;
  lineage: {
    key: string;
    title: string;
    description?: string | null;
    source: LineageAssignmentSource;
    confidence?: number | null;
  };
  relationType: LineageRelationType;
  assignmentSource: LineageAssignmentSource;
  assignmentConfidence?: number | null;
  now?: Date;
}

export class LineageChangeNotFoundError extends Error {
  constructor() {
    super("Canonical change not found in the requested workspace.");
    this.name = "LineageChangeNotFoundError";
  }
}

const normalizeLineageKey = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

const validateConfidence = (
  value: number | null | undefined,
): number | null => {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new RangeError(
      "Lineage confidence must be an integer from 0 to 100.",
    );
  }
  return value;
};

export const execute = async (input: ExecuteInput) => {
  const lineageKey = normalizeLineageKey(input.lineage.key);
  if (lineageKey.length === 0) {
    throw new TypeError(
      "Lineage key must contain at least one letter or number.",
    );
  }
  const lineageTitle = input.lineage.title.trim();
  if (lineageTitle.length === 0) {
    throw new TypeError("Lineage title is required.");
  }
  const lineageConfidence = validateConfidence(input.lineage.confidence);
  const assignmentConfidence = validateConfidence(input.assignmentConfidence);
  const now = input.now ?? new Date();

  return input.db.transaction(async (tx) => {
    const changeRows = await tx
      .select({ lastOccurredAt: changesTable.lastOccurredAt })
      .from(changesTable)
      .where(
        and(
          eq(changesTable.id, input.changeId),
          eq(changesTable.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    const change = changeRows[0];
    if (change === undefined) {
      throw new LineageChangeNotFoundError();
    }

    const proposedLineageId = buildCanonicalId(
      "change-lineage",
      input.workspaceId,
      lineageKey,
    );
    const lineageRows = await tx
      .insert(changeLineagesTable)
      .values({
        id: proposedLineageId,
        workspaceId: input.workspaceId,
        key: lineageKey,
        title: lineageTitle,
        description: input.lineage.description?.trim() || null,
        status: input.relationType === "removed" ? "removed" : "active",
        source: input.lineage.source,
        confidence: lineageConfidence,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [changeLineagesTable.workspaceId, changeLineagesTable.key],
        set: {
          title: lineageTitle,
          description: input.lineage.description?.trim() || null,
          source: input.lineage.source,
          confidence: lineageConfidence,
          updatedAt: now,
        },
      })
      .returning({ id: changeLineagesTable.id });
    const lineageId = lineageRows[0]?.id;
    if (lineageId === undefined) {
      throw new Error("Lineage upsert did not return an id.");
    }

    await tx
      .insert(changeLineageEntriesTable)
      .values({
        lineageId,
        changeId: input.changeId,
        relationType: input.relationType,
        occurredAt: change.lastOccurredAt,
        source: input.assignmentSource,
        confidence: assignmentConfidence,
        correctedAt: input.assignmentSource === "human" ? now : null,
      })
      .onConflictDoUpdate({
        target: [
          changeLineageEntriesTable.lineageId,
          changeLineageEntriesTable.changeId,
        ],
        set: {
          relationType: input.relationType,
          occurredAt: change.lastOccurredAt,
          source: input.assignmentSource,
          confidence: assignmentConfidence,
          correctedAt: input.assignmentSource === "human" ? now : null,
        },
      });

    if (input.relationType === "removed" || input.relationType === "restored") {
      await tx
        .update(changeLineagesTable)
        .set({
          status: input.relationType === "removed" ? "removed" : "active",
          updatedAt: now,
        })
        .where(eq(changeLineagesTable.id, lineageId));
    }

    return { lineageId, lineageKey };
  });
};
