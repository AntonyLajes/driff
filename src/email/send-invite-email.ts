export interface SendInviteEmailInput {
  apiKey: string | undefined;
  from: string | undefined;
  to: string;
  teamName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Halo Mono invite email — mirrors the Pencil `Team - Invite Email` design. */
const renderInviteHtml = (input: Omit<SendInviteEmailInput, "apiKey" | "from">): string => {
  const team = escapeHtml(input.teamName);
  const inviter = escapeHtml(input.inviterName);
  const role = escapeHtml(input.role);
  const url = escapeHtml(input.acceptUrl);
  return `<!doctype html><html><body style="margin:0;background:#F5F5F6;font-family:Inter,Arial,sans-serif;padding:40px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border:1px solid #E4E4E7;border-radius:16px;overflow:hidden;">
      <tr><td align="center" style="padding:28px 24px 8px;">
        <span style="display:inline-block;width:28px;height:28px;background:#E4572E;border-radius:8px;color:#fff;font-weight:600;line-height:28px;text-align:center;">D</span>
        <span style="font-size:17px;font-weight:600;color:#09090B;vertical-align:middle;margin-left:8px;">Driff</span>
      </td></tr>
      <tr><td align="center" style="padding:16px 48px 36px;">
        <div style="width:56px;height:56px;background:#E4572E;border-radius:14px;color:#fff;font-size:20px;font-weight:600;line-height:56px;text-align:center;margin:0 auto;">${escapeHtml(input.teamName.slice(0, 2).toUpperCase())}</div>
        <h1 style="font-size:22px;font-weight:600;color:#09090B;margin:18px 0 0;">You've been invited to ${team}</h1>
        <p style="font-size:14px;line-height:1.5;color:#71717A;margin:14px 0 0;">${inviter} invited you to join the ${team} team on Driff as a ${role}. Accept to start receiving PR, push and version summaries for the team's projects.</p>
        <a href="${url}" style="display:inline-block;margin:22px 0 0;background:#E4572E;color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:999px;">Accept invitation</a>
        <p style="font-size:12.5px;color:#71717A;margin:18px 0 0;">This invitation expires in 7 days.</p>
      </td></tr>
      <tr><td align="center" style="padding:18px 48px;background:#F4F4F5;border-top:1px solid #E4E4E7;">
        <p style="font-size:12px;color:#71717A;margin:0;">If you weren't expecting this, you can safely ignore this email.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
};

export interface SendInviteEmailResult {
  sent: boolean;
  reason?: "not_configured" | "error";
}

/**
 * Sends the invite email via Resend. Best-effort: when the API key is absent
 * the caller still has the copyable accept link, so invites work without email.
 */
export const sendInviteEmail = async (
  input: SendInviteEmailInput,
): Promise<SendInviteEmailResult> => {
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
        subject: `You've been invited to ${input.teamName} on Driff`,
        html: renderInviteHtml(input),
      }),
    });
    return response.ok ? { sent: true } : { sent: false, reason: "error" };
  } catch {
    return { sent: false, reason: "error" };
  }
};
