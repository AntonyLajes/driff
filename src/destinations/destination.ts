export type PRCategory = "feature" | "bugfix" | "refactor" | "chore" | "other";

export interface PRSummary {
  repo: string;
  prNumber: number;
  title: string;
  author: string;
  mergedAt: Date;
  summaryUserFacing: string;
  summaryTechnical: string;
  category: PRCategory;
  area: string | null;
  prUrl: string;
}

export interface Destination {
  publishPR: (summary: PRSummary) => Promise<{ pageId: string }>;
}
