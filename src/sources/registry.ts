import { z } from "zod";

import {
  execute as createGithubSource,
  type ExecuteInput as GithubSourceInput,
} from "@/sources/github/github-source.js";
import type { Source } from "@/sources/source.js";

/**
 * Source providers the data model knows about. Adding one here + a `getSource`
 * case + a `Source` implementation is the whole story for a new provider.
 */
export const SOURCE_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;
export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];

export const sourceProviderSchema = z.enum(SOURCE_PROVIDERS);

/** Providers with a working runtime implementation today. */
export const IMPLEMENTED_SOURCE_PROVIDERS: readonly SourceProvider[] = ["github"];

export const isImplementedProvider = (provider: SourceProvider): boolean =>
  IMPLEMENTED_SOURCE_PROVIDERS.includes(provider);

export class UnsupportedProviderError extends Error {
  constructor(public readonly provider: string) {
    super(`unsupported_provider:${provider}`);
    this.name = "UnsupportedProviderError";
  }
}

/**
 * Resolves a `Source` for the given provider. Only GitHub is wired today; other
 * known providers throw `UnsupportedProviderError` until implemented.
 */
export const getSource = (
  provider: SourceProvider,
  deps: GithubSourceInput = {},
): Source => {
  switch (provider) {
    case "github":
      return createGithubSource(deps);
    default:
      throw new UnsupportedProviderError(provider);
  }
};
