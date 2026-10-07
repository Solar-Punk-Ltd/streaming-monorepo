/**
 * The build an app runs, as its deploy named it: the label `tools/release/version.mjs` printed for the commit it
 * deployed, and that commit. The manager answers its own on `GET /version`, to a signed-in console only.
 */
export interface VersionInfo {
  /**
   * The tag on the commit, the nearest tag before it and how far past it (`QA-build-2026-10-07+3`), or the short
   * commit, ended by `-dirty` when the deploy sent uncommitted changes. Null when no version is set, which is a
   * development build.
   */
  label: string | null;
  /** The full commit, or null when none is set. */
  commit: string | null;
}

/**
 * A label a deploy carries into a shell on a host and into a page without quoting it, the characters version.mjs
 * prints. 96 holds its longest: an 80 character tag, a distance past it and `-dirty`.
 */
export const VERSION_LABEL_RE = /^[A-Za-z0-9._+/-]{1,96}$/;

/** A full commit, as git names it. */
export const VERSION_COMMIT_RE = /^[0-9a-f]{40}$/;

/** How much of the commit is shown beside a label, the length version.mjs shortens it to. */
export const VERSION_SHORT_LENGTH = 9;

/** What is shown for an app that no deploy named. */
export const DEVELOPMENT_BUILD = 'development build';

/** A version from two values of any shape, each null unless it has the shape its field takes. */
export function versionInfo(label: unknown, commit: unknown): VersionInfo {
  return {
    label: typeof label === 'string' && VERSION_LABEL_RE.test(label) ? label : null,
    commit: typeof commit === 'string' && VERSION_COMMIT_RE.test(commit) ? commit : null,
  };
}

/** A version as a page shows it: the text, and the full commit for the element's title. */
export interface VersionDisplay {
  text: string;
  title: string | null;
}

/**
 * The display rule, the same in every console: `<label> (<first 9 of the commit>)`, or the label alone when it
 * already starts with those 9 characters, as an untagged build's does, and `development build` when no version is
 * set. The full commit is the title either way.
 */
export function versionDisplay(version: VersionInfo): VersionDisplay {
  const { label, commit } = version;
  if (label === null) return { text: DEVELOPMENT_BUILD, title: commit };
  if (commit === null) return { text: label, title: null };
  const short = commit.slice(0, VERSION_SHORT_LENGTH);
  return { text: label.startsWith(short) ? label : `${label} (${short})`, title: commit };
}
