/**
 * Productivity heuristic: minutes of review reading saved per summarized item.
 * Mirrored client-side in the front-end (home/metrics) — keep both in sync.
 * Never expose cost/token figures to users; time saved is the only framing.
 */
export const MINUTES_SAVED_PER_PR = 20;
export const MINUTES_SAVED_PER_PUSH = 5;

export const reviewTimeSavedMinutes = (prs: number, pushes: number): number =>
  prs * MINUTES_SAVED_PER_PR + pushes * MINUTES_SAVED_PER_PUSH;
