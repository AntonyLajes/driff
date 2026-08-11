import { z } from "zod";

export const releaseVersionStrategySchema = z.enum([
  "version_file",
  "git_tag",
  "github_release",
]);

export type ReleaseVersionStrategy = z.infer<
  typeof releaseVersionStrategySchema
>;

export const DEFAULT_RELEASE_VERSION_STRATEGY: ReleaseVersionStrategy =
  "version_file";

export const parseReleaseVersionStrategy = (
  value: string | null | undefined,
): ReleaseVersionStrategy => {
  const parsed = releaseVersionStrategySchema.safeParse(
    value?.trim().toLowerCase(),
  );
  return parsed.success ? parsed.data : DEFAULT_RELEASE_VERSION_STRATEGY;
};
