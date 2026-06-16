export interface SendWhitelistEmailInput {
  apiKey: string | undefined;
  from: string | undefined;
  to: string;
  name: string;
  /** Landing language the lead used (e.g. "pt", "pt-BR"). Falls back to English. */
  locale?: string;
}

interface WhitelistStrings {
  subject: string;
  heading: string; // may contain {name}
  p1: string;
  p2: string; // mentions the 10-day window
  p3: string;
  signoff: string;
  team: string;
  footerNote: string;
}

const TEMPLATES: Record<string, WhitelistStrings> = {
  en: {
    subject: "Thank you for joining the Driff waitlist 🙏",
    heading: "Thank you so much, {name}! 🎉",
    p1: "We're truly grateful that you want to be part of the Driff beta. It genuinely means a lot to us that you'd trust Driff with your team's workflow.",
    p2: "We'll review your request with care and get back to you within 10 days with the next steps.",
    p3: "Until then, sit tight — we can't wait to have you on board. 🧡",
    signoff: "With gratitude,",
    team: "The Driff Team",
    footerNote: "If you didn't sign up for Driff, you can safely ignore this email.",
  },
  pt: {
    subject: "Obrigado por entrar na whitelist do Driff 🙏",
    heading: "Muito obrigado, {name}! 🎉",
    p1: "Somos muito gratos por você querer fazer parte do beta do Driff. Significa muito pra gente que você confie no Driff pro fluxo do seu time.",
    p2: "Vamos avaliar sua inscrição com carinho e entrar em contato em até 10 dias com os próximos passos.",
    p3: "Até lá, é só aguardar — mal podemos esperar pra ter você com a gente. 🧡",
    signoff: "Com gratidão,",
    team: "Equipe Driff",
    footerNote: "Se você não se inscreveu no Driff, pode ignorar este e-mail tranquilamente.",
  },
  es: {
    subject: "Gracias por unirte a la lista de Driff 🙏",
    heading: "¡Muchas gracias, {name}! 🎉",
    p1: "Estamos muy agradecidos de que quieras ser parte del beta de Driff. Significa mucho para nosotros que confíes en Driff para el flujo de tu equipo.",
    p2: "Revisaremos tu solicitud con cuidado y te contactaremos en un plazo de 10 días con los próximos pasos.",
    p3: "Hasta entonces, solo espera — no vemos la hora de tenerte con nosotros. 🧡",
    signoff: "Con gratitud,",
    team: "El equipo de Driff",
    footerNote: "Si no te inscribiste en Driff, puedes ignorar este correo.",
  },
  de: {
    subject: "Danke, dass du auf der Driff-Warteliste bist 🙏",
    heading: "Vielen Dank, {name}! 🎉",
    p1: "Wir sind wirklich dankbar, dass du Teil der Driff-Beta sein möchtest. Es bedeutet uns viel, dass du Driff den Workflow deines Teams anvertraust.",
    p2: "Wir prüfen deine Anfrage sorgfältig und melden uns innerhalb von 10 Tagen mit den nächsten Schritten.",
    p3: "Bis dahin heißt es abwarten — wir freuen uns riesig auf dich. 🧡",
    signoff: "Mit Dankbarkeit,",
    team: "Das Driff-Team",
    footerNote: "Falls du dich nicht angemeldet hast, kannst du diese E-Mail ignorieren.",
  },
  zh: {
    subject: "感谢你加入 Driff 候补名单 🙏",
    heading: "非常感谢你，{name}！🎉",
    p1: "你愿意加入 Driff 内测，我们由衷感激。你愿意把团队的工作流程托付给 Driff，对我们意义重大。",
    p2: "我们会认真评估你的申请，并在 10 天内与你联系，告知后续步骤。",
    p3: "在此之前请稍候——我们非常期待与你同行。🧡",
    signoff: "致以诚挚的谢意，",
    team: "Driff 团队",
    footerNote: "如果你没有注册 Driff，请忽略此邮件。",
  },
};

const pickStrings = (locale: string | undefined): WhitelistStrings => {
  const base = ((locale ?? "en").split("-")[0] ?? "en").toLowerCase();
  return TEMPLATES[base] ?? (TEMPLATES.en as WhitelistStrings);
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Halo Mono confirmation email for a beta whitelist signup. */
const renderWhitelistHtml = (name: string, t: WhitelistStrings): string => {
  const firstName = escapeHtml((name.trim().split(/\s+/)[0] ?? name) || "there");
  const heading = t.heading.replace("{name}", firstName);
  return `<!doctype html><html><body style="margin:0;background:#F5F5F6;font-family:Inter,Arial,sans-serif;padding:40px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border:1px solid #E4E4E7;border-radius:16px;overflow:hidden;">
      <tr><td align="center" style="padding:28px 24px 8px;">
        <span style="display:inline-block;width:28px;height:28px;background:#E4572E;border-radius:8px;color:#fff;font-weight:600;line-height:28px;text-align:center;">D</span>
        <span style="font-size:17px;font-weight:600;color:#09090B;vertical-align:middle;margin-left:8px;">Driff</span>
      </td></tr>
      <tr><td align="center" style="padding:16px 44px 36px;">
        <h1 style="font-size:22px;font-weight:600;color:#09090B;margin:18px 0 0;">${heading}</h1>
        <p style="font-size:14px;line-height:1.6;color:#52525B;margin:16px 0 0;">${escapeHtml(t.p1)}</p>
        <p style="font-size:14px;line-height:1.6;color:#52525B;margin:14px 0 0;"><strong style="color:#09090B;">${escapeHtml(t.p2)}</strong></p>
        <p style="font-size:14px;line-height:1.6;color:#52525B;margin:14px 0 0;">${escapeHtml(t.p3)}</p>
        <p style="font-size:14px;line-height:1.6;color:#09090B;margin:22px 0 0;">${escapeHtml(t.signoff)}<br/><strong>${escapeHtml(t.team)}</strong></p>
      </td></tr>
      <tr><td align="center" style="padding:18px 44px;background:#F4F4F5;border-top:1px solid #E4E4E7;">
        <p style="font-size:12px;color:#71717A;margin:0;">${escapeHtml(t.footerNote)}</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
};

export interface SendWhitelistEmailResult {
  sent: boolean;
  reason?: "not_configured" | "error";
}

/**
 * Sends the whitelist confirmation email via Resend, in the lead's language
 * (falls back to English). Best-effort: without the API key the signup still
 * succeeds (the row is persisted regardless).
 */
export const sendWhitelistEmail = async (
  input: SendWhitelistEmailInput,
): Promise<SendWhitelistEmailResult> => {
  if (input.apiKey === undefined || input.from === undefined) {
    return { sent: false, reason: "not_configured" };
  }
  const t = pickStrings(input.locale);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        subject: t.subject,
        html: renderWhitelistHtml(input.name, t),
      }),
    });
    return response.ok ? { sent: true } : { sent: false, reason: "error" };
  } catch {
    return { sent: false, reason: "error" };
  }
};
