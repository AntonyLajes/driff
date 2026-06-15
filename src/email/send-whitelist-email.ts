export interface SendWhitelistEmailInput {
  apiKey: string | undefined;
  from: string | undefined;
  to: string;
  name: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Halo Mono confirmation email for a beta whitelist signup. */
const renderWhitelistHtml = (name: string): string => {
  const firstName = escapeHtml(name.trim().split(/\s+/)[0] ?? name);
  return `<!doctype html><html><body style="margin:0;background:#F5F5F6;font-family:Inter,Arial,sans-serif;padding:40px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border:1px solid #E4E4E7;border-radius:16px;overflow:hidden;">
      <tr><td align="center" style="padding:28px 24px 8px;">
        <span style="display:inline-block;width:28px;height:28px;background:#E4572E;border-radius:8px;color:#fff;font-weight:600;line-height:28px;text-align:center;">D</span>
        <span style="font-size:17px;font-weight:600;color:#09090B;vertical-align:middle;margin-left:8px;">Driff</span>
      </td></tr>
      <tr><td align="center" style="padding:16px 48px 36px;">
        <h1 style="font-size:22px;font-weight:600;color:#09090B;margin:18px 0 0;">Você está na lista, ${firstName}! 🎉</h1>
        <p style="font-size:14px;line-height:1.5;color:#71717A;margin:14px 0 0;">Recebemos sua inscrição no beta fechado do Driff. Estamos abrindo acesso para um grupo selecionado de times — assim que sua vaga abrir, você recebe um convite por aqui.</p>
        <p style="font-size:14px;line-height:1.5;color:#71717A;margin:14px 0 0;">Enquanto isso, é só aguardar. Sem spam: você só ouve de nós quando for a sua vez.</p>
        <p style="font-size:13px;line-height:1.5;color:#09090B;margin:22px 0 0;font-weight:600;">— Equipe Driff</p>
      </td></tr>
      <tr><td align="center" style="padding:18px 48px;background:#F4F4F5;border-top:1px solid #E4E4E7;">
        <p style="font-size:12px;color:#71717A;margin:0;">Se você não se inscreveu, pode ignorar este e-mail com tranquilidade.</p>
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
 * Sends the whitelist confirmation email via Resend. Best-effort: without the
 * API key the signup still succeeds (the row is persisted regardless).
 */
export const sendWhitelistEmail = async (
  input: SendWhitelistEmailInput,
): Promise<SendWhitelistEmailResult> => {
  if (input.apiKey === undefined || input.from === undefined) {
    return { sent: false, reason: "not_configured" };
  }
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
        subject: "Você entrou na whitelist do Driff 🎉",
        html: renderWhitelistHtml(input.name),
      }),
    });
    return response.ok ? { sent: true } : { sent: false, reason: "error" };
  } catch {
    return { sent: false, reason: "error" };
  }
};
