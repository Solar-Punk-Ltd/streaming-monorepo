/** One container and the commit it was seen to be started from, or null before an observation. */
export interface ObservedContainer {
  service: string;
  buildCommit: string | null;
  /** The release that build was made as, or null for a build made with none. Absent reads as null. */
  buildLabel?: string | null;
}

export type RunningCommit =
  | { kind: 'one'; commit: string }
  | { kind: 'mixed'; byService: { service: string; commit: string | null }[] }
  | { kind: 'unknown' };

/**
 * What a deployment runs, as its containers were seen: one commit when every
 * container agrees, mixed naming each service when they do not, unknown when
 * nothing was observed.
 */
export function runningCommitOf(containers: readonly ObservedContainer[]): RunningCommit {
  if (containers.length === 0) return { kind: 'unknown' };
  const commits = new Set(containers.map((container) => container.buildCommit));
  const [only] = commits;
  if (commits.size === 1 && only) return { kind: 'one', commit: only };
  if (commits.size === 1) return { kind: 'unknown' };
  return {
    kind: 'mixed',
    byService: containers.map((container) => ({ service: container.service, commit: container.buildCommit })),
  };
}

/** The release a deployment runs, and the commit it names. */
export interface RunningLabel {
  label: string;
  commit: string;
}

/**
 * The release a deployment runs, as its containers were seen: the label of
 * their build when every container agrees on one commit and one label, or
 * null when nothing was observed, a build carries no label, or they disagree.
 * Two builds of one commit can carry two labels, so agreeing on the commit is
 * not enough.
 */
export function runningLabelOf(containers: readonly ObservedContainer[]): RunningLabel | null {
  const running = runningCommitOf(containers);
  if (running.kind !== 'one') return null;
  const labels = new Set(containers.map((container) => container.buildLabel ?? null));
  const [only] = labels;
  return labels.size === 1 && only ? { label: only, commit: running.commit } : null;
}
