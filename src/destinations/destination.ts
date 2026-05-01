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

export interface ReleaseNotesSummary {
  title: string;
  repo: string;
  branch: string;
  newVersionKey: string;
  previousVersionKey: string | null;
  shortVersion: string;
  buildVersion: string;
  compareUrl: string;
  prNumbers: number[];
  /** Narrativa curta de changelog para utilizadores finais / produto. */
  changelog: string;
  sections: Array<{ label: string; items: string[] }>;
}

export interface Destination {
  publishPR: (summary: PRSummary) => Promise<{ pageId: string }>;
  publishRelease: (summary: ReleaseNotesSummary) => Promise<{ pageId: string }>;
}
