export interface NormalizedProductArea {
  name: string;
  slug: string;
}

const canonicalAliases: Record<string, NormalizedProductArea> = {
  auth: { name: "Auth", slug: "auth" },
  authentication: { name: "Auth", slug: "auth" },
  "create-ride": { name: "Ride creation", slug: "ride-creation" },
  "create-ride-wizard": { name: "Ride creation", slug: "ride-creation" },
  "ride-creation": { name: "Ride creation", slug: "ride-creation" },
  i18n: { name: "Localization", slug: "localization" },
  internationalization: { name: "Localization", slug: "localization" },
  localization: { name: "Localization", slug: "localization" },
  "ride-screens": { name: "Rides", slug: "rides" },
  rides: { name: "Rides", slug: "rides" },
  theme: { name: "Theme", slug: "theme" },
  theming: { name: "Theme", slug: "theme" },
};

const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

const displayName = (slug: string): string => {
  const words = slug.split("-").filter((word) => word.length > 0);
  return words
    .map((word, index) => {
      if (["api", "ui", "ux"].includes(word)) return word.toUpperCase();
      return index === 0 ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : word;
    })
    .join(" ");
};

/**
 * Turns the free-form area label returned by the summarizer into one stable,
 * manager-facing product area. Hierarchical labels keep their most specific
 * (right-most) segment, while common synonyms share a canonical identity.
 * The original label remains available on the PR/push source record.
 */
export const normalizeProductArea = (
  rawArea: string | null | undefined,
): NormalizedProductArea | null => {
  const raw = rawArea?.trim() ?? "";
  if (raw.length === 0) return null;

  const segments = raw
    .split(/\s*(?:\/|>|→|::)\s*/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const leaf = segments.at(-1) ?? raw;
  const slug = slugify(leaf);
  if (slug.length === 0) return null;

  return canonicalAliases[slug] ?? { name: displayName(slug), slug };
};
