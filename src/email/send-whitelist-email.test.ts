import { afterEach, describe, expect, it, vi } from "vitest";

import { sendWhitelistEmail } from "@/email/send-whitelist-email.js";

const base = {
  apiKey: "resend-key",
  from: "Driff <hi@driff.dev>",
  to: "lead@example.com",
  name: "<Antony> Lajes",
};

describe("email/send-whitelist-email", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stays optional when email delivery is not configured", async () => {
    await expect(
      sendWhitelistEmail({ ...base, apiKey: undefined }),
    ).resolves.toEqual({ sent: false, reason: "not_configured" });
  });

  it.each([
    ["en", "Thank you for joining"],
    ["pt-BR", "Obrigado por entrar"],
    ["es", "Gracias por unirte"],
    ["de", "Danke, dass du"],
    ["zh-CN", "感谢你加入"],
    ["unknown", "Thank you for joining"],
  ])("renders the %s template and escapes the lead name", async (locale, subject) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));

    await expect(sendWhitelistEmail({ ...base, locale })).resolves.toEqual({
      sent: true,
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { subject: string; html: string };
    expect(body.subject).toContain(subject);
    expect(body.html).toContain("&lt;Antony&gt;");
  });

  it("falls back to a friendly name and contains provider failures", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("bad", { status: 500 }))
      .mockRejectedValueOnce(new Error("offline"));

    await expect(
      sendWhitelistEmail({ ...base, name: "   ", locale: undefined }),
    ).resolves.toEqual({ sent: false, reason: "error" });
    const firstBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { html: string };
    expect(firstBody.html).toContain("there");

    await expect(sendWhitelistEmail(base)).resolves.toEqual({
      sent: false,
      reason: "error",
    });
  });
});
