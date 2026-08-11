import { afterEach, describe, expect, it, vi } from "vitest";

import { sendInviteEmail } from "@/email/send-invite-email.js";

const input = {
  apiKey: "resend-key",
  from: "Driff <hi@driff.dev>",
  to: "dev@example.com",
  teamName: "R&D <Team>",
  inviterName: 'Antony "Tony" & Co',
  role: "admin",
  acceptUrl: "https://driff.dev/invite?a=1&b=2",
};

describe("email/send-invite-email", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stays optional when Resend is not configured", async () => {
    await expect(
      sendInviteEmail({ ...input, apiKey: undefined }),
    ).resolves.toEqual({ sent: false, reason: "not_configured" });
    await expect(sendInviteEmail({ ...input, from: undefined })).resolves.toEqual({
      sent: false,
      reason: "not_configured",
    });
  });

  it("sends escaped invite HTML through Resend", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));

    await expect(sendInviteEmail(input)).resolves.toEqual({ sent: true });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { subject: string; html: string };
    expect(request.headers).toMatchObject({ Authorization: "Bearer resend-key" });
    expect(body.subject).toContain("R&D <Team>");
    expect(body.html).toContain("R&amp;D &lt;Team&gt;");
    expect(body.html).toContain("Antony &quot;Tony&quot; &amp; Co");
    expect(body.html).toContain("a=1&amp;b=2");
  });

  it("contains provider HTTP and network failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("bad", { status: 400 }),
    );
    await expect(sendInviteEmail(input)).resolves.toEqual({
      sent: false,
      reason: "error",
    });

    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("offline"));
    await expect(sendInviteEmail(input)).resolves.toEqual({
      sent: false,
      reason: "error",
    });
  });
});
