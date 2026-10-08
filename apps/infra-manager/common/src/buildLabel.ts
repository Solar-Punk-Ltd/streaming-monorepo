import { VERSION_LABEL_RE, VERSION_SHORT_LENGTH, versionDisplay } from './versionInfo.js';

/**
 * The release a build of the streaming stack is named by, and how every page of
 * the manager shows one. docs/features/stack-versions.md says where a label
 * comes from: the label the manager was deployed with for the bundled version,
 * and the tag on the commit for a version an operator added.
 *
 * A label reaches the manager's pages only behind sign-in. Since 2026-10-08 a
 * deploy also builds it into the player of a version that takes it, whose QoE
 * overlay, opened with `?qoe=1` on a watch URL, is the one place a viewer can
 * see it. The rules are the manager's own version's, in versionInfo.ts, so the
 * sidebar and the stack pages hold one rule between them, and the player shows
 * a release by the same one.
 */

/** What a label may hold: letters, digits and `. _ + / -`, one to 96 of them, VERSION_LABEL_RE. */
export const BUILD_LABEL_RE = VERSION_LABEL_RE;

export function isBuildLabel(value: unknown): value is string {
  return typeof value === 'string' && BUILD_LABEL_RE.test(value);
}

/** How many characters of a commit stand beside a label, VERSION_SHORT_LENGTH. */
export const LABEL_COMMIT_LENGTH = VERSION_SHORT_LENGTH;

/** A label as a page shows it. */
export interface BuildLabelText {
  /** `<label> (<first 9 of the commit>)`, or the label alone when it already starts with those 9 characters. */
  text: string;
  /** The whole commit, for the element's title, or undefined when the commit is not known. */
  title: string | undefined;
}

/**
 * The display rule every page of the manager shares, versionDisplay's: `QA-build-2026-10-07
 * (635b4e175)`, or `635b4e175-dirty` alone, because that label already names
 * the commit, with the whole commit as the element's title.
 */
export function buildLabelText(label: string, commit: string | null | undefined): BuildLabelText {
  const { text, title } = versionDisplay({ label, commit: commit || null });
  return { text, title: title ?? undefined };
}
