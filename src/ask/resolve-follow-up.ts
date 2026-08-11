import type { AskConversationTurn } from "@/ask/compose-answer.js";

export interface ExecuteInput {
  question: string;
  conversation: AskConversationTurn[];
}

const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

const isContextDependent = (question: string): boolean => {
  const normalized = normalize(question);
  if (normalized.split(/\s+/u).length > 12) return false;
  if (/\bv?\d+(?:\.\d+){1,3}\b/u.test(normalized)) return false;
  return /^(?:(?:e|and)\s+)?(?:em\s+qual|quem|quando|onde|qual|quais|isso|essa|esse|ele|ela|who|when|where|which|what\s+about|this|that|it)\b/u.test(
    normalized,
  );
};

export const execute = ({
  question,
  conversation,
}: ExecuteInput): string => {
  if (!isContextDependent(question)) return question;
  const previousAnswer = [...conversation]
    .reverse()
    .find((turn) => turn.role === "assistant")?.content;
  if (previousAnswer === undefined) return question;
  return `${previousAnswer}\nFollow-up question: ${question}`;
};
