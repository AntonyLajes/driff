import { describe, expect, it } from "vitest";

import { execute } from "@/ask/resolve-follow-up.js";

describe("ask/resolve-follow-up execute", () => {
  it("should enrich a short contextual follow-up with the previous answer", () => {
    expect(
      execute({
        question: "E quem fez isso?",
        conversation: [
          { role: "user", content: "Qual foi a última feature?" },
          {
            role: "assistant",
            content: "A última feature melhorou os botões rápidos da Home.",
          },
        ],
      }),
    ).toBe(
      "A última feature melhorou os botões rápidos da Home.\nFollow-up question: E quem fez isso?",
    );
  });

  it("should keep a standalone question unchanged", () => {
    expect(
      execute({
        question: "O que mudou no checkout nos últimos 30 dias?",
        conversation: [
          { role: "assistant", content: "A Home recebeu melhorias." },
        ],
      }),
    ).toBe("O que mudou no checkout nos últimos 30 dias?");
  });

  it("should keep a follow-up unchanged without an assistant answer", () => {
    expect(
      execute({
        question: "Which version included it?",
        conversation: [{ role: "user", content: "What changed?" }],
      }),
    ).toBe("Which version included it?");
  });
});
