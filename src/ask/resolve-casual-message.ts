export type CasualMessageKind =
  | "greeting"
  | "thanks"
  | "farewell"
  | "capabilities";

export interface CasualMessage {
  kind: CasualMessageKind;
  answerText: string;
}

type Locale = "pt" | "en" | "es" | "de" | "fr" | "zh";

const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:driff|hey driff|ola driff|hello driff)\s*/u, "")
    .replace(/\s+driff$/u, "")
    .trim();

const phrases: Record<
  Locale,
  Record<CasualMessageKind, ReadonlySet<string>>
> = {
  pt: {
    greeting: new Set([
      "oi",
      "ola",
      "e ai",
      "bom dia",
      "boa tarde",
      "boa noite",
      "tudo bem",
      "como vai",
      "como voce esta",
    ]),
    thanks: new Set([
      "obrigado",
      "obrigada",
      "valeu",
      "muito obrigado",
      "muito obrigada",
    ]),
    farewell: new Set(["tchau", "ate mais", "ate logo", "falou"]),
    capabilities: new Set([
      "ajuda",
      "me ajude",
      "o que voce faz",
      "como voce pode me ajudar",
      "o que posso perguntar",
    ]),
  },
  en: {
    greeting: new Set([
      "hi",
      "hello",
      "hey",
      "good morning",
      "good afternoon",
      "good evening",
      "how are you",
      "how is it going",
    ]),
    thanks: new Set(["thanks", "thank you", "thanks a lot", "many thanks"]),
    farewell: new Set(["bye", "goodbye", "see you", "see you later"]),
    capabilities: new Set([
      "help",
      "help me",
      "what can you do",
      "how can you help me",
      "what can i ask",
    ]),
  },
  es: {
    greeting: new Set([
      "hola",
      "buenos dias",
      "buenas tardes",
      "buenas noches",
      "como estas",
    ]),
    thanks: new Set(["gracias", "muchas gracias"]),
    farewell: new Set(["adios", "hasta luego", "nos vemos"]),
    capabilities: new Set([
      "ayuda",
      "ayudame",
      "que puedes hacer",
      "que puedo preguntar",
    ]),
  },
  de: {
    greeting: new Set([
      "hallo",
      "hi",
      "guten morgen",
      "guten tag",
      "guten abend",
      "wie geht es dir",
    ]),
    thanks: new Set(["danke", "vielen dank"]),
    farewell: new Set(["tschuss", "auf wiedersehen", "bis spater"]),
    capabilities: new Set([
      "hilfe",
      "hilf mir",
      "was kannst du",
      "was kann ich fragen",
    ]),
  },
  fr: {
    greeting: new Set([
      "bonjour",
      "salut",
      "bonsoir",
      "comment ca va",
      "comment allez vous",
    ]),
    thanks: new Set(["merci", "merci beaucoup"]),
    farewell: new Set(["au revoir", "a bientot", "salut"]),
    capabilities: new Set([
      "aide",
      "aide moi",
      "que peux tu faire",
      "que puis je demander",
    ]),
  },
  zh: {
    greeting: new Set(["你好", "您好", "早上好", "下午好", "晚上好"]),
    thanks: new Set(["谢谢", "多谢"]),
    farewell: new Set(["再见", "拜拜"]),
    capabilities: new Set(["帮助", "你能做什么", "我可以问什么"]),
  },
};

const answers: Record<Locale, Record<CasualMessageKind, string>> = {
  pt: {
    greeting:
      "Olá! Como posso ajudar? Você pode me perguntar sobre mudanças, versões, funcionalidades e participantes deste projeto.",
    thanks:
      "Por nada! Se quiser, posso continuar investigando o histórico deste projeto com você.",
    farewell:
      "Até mais! Quando precisar, o histórico do projeto estará por aqui.",
    capabilities:
      "Posso investigar o histórico deste projeto para explicar o que mudou, quando uma funcionalidade entrou, em qual versão ela foi entregue e quem participou.",
  },
  en: {
    greeting:
      "Hello! How can I help? You can ask me about changes, versions, features and contributors in this project.",
    thanks:
      "You're welcome! I can keep investigating this project's history whenever you need.",
    farewell: "See you! The project's history will be here when you need it.",
    capabilities:
      "I can investigate this project's history to explain what changed, when a feature was added, which version included it and who participated.",
  },
  es: {
    greeting:
      "¡Hola! ¿Cómo puedo ayudarte? Puedes preguntarme sobre cambios, versiones, funcionalidades y participantes de este proyecto.",
    thanks:
      "¡De nada! Puedo seguir investigando el historial de este proyecto cuando quieras.",
    farewell:
      "¡Hasta luego! El historial del proyecto estará aquí cuando lo necesites.",
    capabilities:
      "Puedo investigar el historial de este proyecto para explicar qué cambió, cuándo se añadió una funcionalidad, en qué versión entró y quién participó.",
  },
  de: {
    greeting:
      "Hallo! Wie kann ich helfen? Du kannst mich nach Änderungen, Versionen, Funktionen und Beteiligten in diesem Projekt fragen.",
    thanks:
      "Gern! Ich kann den Verlauf dieses Projekts jederzeit weiter mit dir untersuchen.",
    farewell: "Bis bald! Der Projektverlauf ist da, wenn du ihn brauchst.",
    capabilities:
      "Ich kann den Verlauf dieses Projekts untersuchen und erklären, was geändert wurde, wann eine Funktion hinzukam, in welcher Version sie enthalten war und wer beteiligt war.",
  },
  fr: {
    greeting:
      "Bonjour ! Comment puis-je vous aider ? Vous pouvez m'interroger sur les changements, les versions, les fonctionnalités et les contributeurs de ce projet.",
    thanks:
      "Avec plaisir ! Je peux continuer à explorer l'historique de ce projet quand vous le souhaitez.",
    farewell:
      "À bientôt ! L'historique du projet sera là quand vous en aurez besoin.",
    capabilities:
      "Je peux explorer l'historique de ce projet pour expliquer ce qui a changé, quand une fonctionnalité a été ajoutée, dans quelle version elle est arrivée et qui a participé.",
  },
  zh: {
    greeting:
      "你好！我能帮你做什么？你可以询问这个项目的改动、版本、功能和参与者。",
    thanks: "不客气！需要时，我可以继续和你一起查看这个项目的历史。",
    farewell: "再见！需要时，项目历史随时都在这里。",
    capabilities:
      "我可以查看这个项目的历史，说明改了什么、功能何时加入、属于哪个版本以及谁参与了。",
  },
};

export const execute = (message: string): CasualMessage | null => {
  const normalized = normalize(message);
  if (normalized.length === 0) return null;

  const kinds: CasualMessageKind[] = [
    "greeting",
    "thanks",
    "farewell",
    "capabilities",
  ];
  for (const locale of Object.keys(phrases) as Locale[]) {
    for (const kind of kinds) {
      if (phrases[locale][kind].has(normalized)) {
        return { kind, answerText: answers[locale][kind] };
      }
    }
  }
  return null;
};
