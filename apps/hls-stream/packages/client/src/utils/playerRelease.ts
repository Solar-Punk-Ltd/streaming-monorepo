/**
 * The release this player was built as, which its QoE overlay shows and nothing else does.
 *
 * `deploy/scripts/deploy.sh` takes it as `--release-label` and `--release-commit`, refuses either in
 * any other shape than the two below, and builds both into the bundle as `VITE_APP_RELEASE_LABEL` and
 * `VITE_APP_RELEASE_COMMIT`. The deployment manager passes the label and the commit of the stack build
 * a deployment runs. They are read again here rather than trusted, so a bundle built some other way
 * shows nothing it should not, and the overlay prints them as text.
 */

/** A label: letters, digits and `. _ + / -`, one to 96 of them, as a release is named wherever it is. */
const RELEASE_LABEL_RE = /^[A-Za-z0-9._+/-]{1,96}$/;

/** A whole commit. */
const RELEASE_COMMIT_RE = /^[0-9a-f]{40}$/;

/** How much of the commit stands beside the label. */
const RELEASE_SHORT_LENGTH = 9;

export interface PlayerRelease {
  label: string;
  /** The whole commit, or null when the build named none. */
  commit: string | null;
}

/** The release from two build-time values of any shape, or null when there is no label to show. */
export function playerRelease(label: unknown, commit: unknown): PlayerRelease | null {
  if (typeof label !== 'string' || !RELEASE_LABEL_RE.test(label)) return null;
  return { label, commit: typeof commit === 'string' && RELEASE_COMMIT_RE.test(commit) ? commit : null };
}

/**
 * The release as the overlay shows it, by the rule every console of this project shows a release by:
 * `<label> (<first 9 of the commit>)`, or the label alone when it already starts with those 9, as an
 * untagged build's does, or when there is no commit.
 */
export function playerReleaseText(release: PlayerRelease): string {
  if (release.commit === null) return release.label;
  const short = release.commit.slice(0, RELEASE_SHORT_LENGTH);
  return release.label.startsWith(short) ? release.label : `${release.label} (${short})`;
}
