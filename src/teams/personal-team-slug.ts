import { slugifyWorkspaceName } from "@/lib/workspace-slug.js";

/**
 * Friendly base slug for a user's personal team, used in URLs (e.g. /t/antony).
 * Prefers the display name, falls back to the email's local part, then "user".
 */
export const personalTeamBaseSlug = (
  name: string | null | undefined,
  email: string | null | undefined,
): string => {
  const fromName = name ? slugifyWorkspaceName(name) : "";
  if (fromName.length > 0 && fromName !== "workspace") {
    return fromName;
  }
  const localPart = email?.split("@")[0] ?? "";
  const fromEmail = localPart.length > 0 ? slugifyWorkspaceName(localPart) : "";
  if (fromEmail.length > 0 && fromEmail !== "workspace") {
    return fromEmail;
  }
  return "user";
};

/** True for the legacy auto-generated personal slug that should be upgraded. */
export const isLegacyPersonalSlug = (slug: string): boolean =>
  slug.startsWith("personal-");
