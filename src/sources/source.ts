export interface PullRequestEventFile {
  path: string;
  additions: number;
  deletions: number;
}

export type PullRequestParticipantRole =
  | "commit_author"
  | "reviewer"
  | "coauthor"
  | "merger";

export interface PullRequestParticipant {
  externalIdentity: string;
  displayName: string | null;
  role: PullRequestParticipantRole;
  sourceUrl: string | null;
  isBot: boolean;
}

export interface PullRequestEvent {
  repo: string;
  prNumber: number;
  title: string;
  body: string | null;
  author: string;
  mergedAt: Date;
  headSha: string;
  baseBranch: string;
  diff: string;
  files: PullRequestEventFile[];
  /** Collaboration context collected from GitHub. Optional for legacy fixtures. */
  participants?: PullRequestParticipant[];
}

export interface Source {
  fetchPullRequest: (
    repo: string,
    prNumber: number,
  ) => Promise<PullRequestEvent>;
}
