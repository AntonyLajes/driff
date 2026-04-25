export interface PullRequestEventFile {
  path: string;
  additions: number;
  deletions: number;
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
}

export interface Source {
  fetchPullRequest: (repo: string, prNumber: number) => Promise<PullRequestEvent>;
}
