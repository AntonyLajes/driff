/**
 * Derives a URL-safe slug from a display name (used when the client omits `slug`).
 */
export const slugifyWorkspaceName = (name: string): string => {
  const normalized = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "workspace";
};

/**
 * Normalizes an explicit slug from the client (lowercase, single hyphens, trim).
 */
export const normalizeWorkspaceSlug = (slug: string): string =>
  slug
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
