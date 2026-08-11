import { describe, expect, it } from "vitest";

import { execute } from "@/ask/resolve-casual-message.js";

describe("ask/resolve-casual-message", () => {
  it.each([
    ["Olá!", "greeting", "Olá!"],
    ["Olá, tudo bem com você?", "greeting", "Olá!"],
    ["oi Driff", "greeting", "Olá!"],
    ["Hello, how are you?", "greeting", "Hello!"],
    ["Thanks", "thanks", "You're welcome!"],
    ["Muchas gracias", "thanks", "¡De nada!"],
    ["Au revoir", "farewell", "À bientôt !"],
    ["你能做什么？", "capabilities", "我可以查看"],
  ])(
    "should answer casual message %s without evidence",
    (message, kind, answer) => {
      expect(execute(message)).toEqual(
        expect.objectContaining({
          kind,
          answerText: expect.stringContaining(answer),
        }),
      );
    },
  );

  it.each([
    "Olá, qual foi a última feature?",
    "Hi, who changed the Home screen?",
    "Obrigado. Em qual versão isso entrou?",
  ])("should preserve concrete history questions: %s", (message) => {
    expect(execute(message)).toBeNull();
  });
});
