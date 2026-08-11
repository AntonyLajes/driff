import { z } from "zod";

export const summaryLanguageSchema = z.enum(["auto", "en", "pt-BR"]);
export type SummaryLanguage = z.infer<typeof summaryLanguageSchema>;

/** Normalizes persisted workspace output-language configuration. */
export const execute = (value: unknown): SummaryLanguage => {
  const parsed = summaryLanguageSchema.safeParse(value);
  return parsed.success ? parsed.data : "auto";
};
