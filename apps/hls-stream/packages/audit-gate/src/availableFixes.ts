import { Advisory, AllowedAdvisory, GateFailure } from './types.js';

/** Answers which published releases of a package satisfy a semver range. The registry does the matching. */
export type PublishedVersionsIn = (packageName: string, range: string) => Promise<string[]>;

/**
 * What npm says when a range matches no published release. It comes with E404, the code npm also gives a package the
 * registry does not know at all, so the summary is what tells "no release yet" from "could not look it up".
 */
const NO_MATCH_SUMMARY = 'No match found for version';

const MAX_QUOTED_OUTPUT = 200;

/**
 * Reads what `npm view <package>@<range> version --json` printed: one release as a string, several as a list, and no
 * match as an E404 error whose summary says so. Anything else throws, because an answer the gate cannot read is not
 * an answer that no fix exists.
 */
export function parseNpmViewVersions(exitCode: number, stdout: string, spec: string): string[] {
  const command = `npm view ${spec} version --json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${command} printed no JSON (exit ${exitCode}): ${stdout.slice(0, MAX_QUOTED_OUTPUT)}`);
  }

  if (exitCode === 0) {
    if (typeof parsed === 'string') {
      return [parsed];
    }
    if (Array.isArray(parsed) && parsed.every((release) => typeof release === 'string')) {
      return parsed;
    }
    throw new Error(
      `${command} printed something that is not a release or a list of them: ${stdout.slice(0, MAX_QUOTED_OUTPUT)}`,
    );
  }

  const error = (parsed as { error?: { code?: unknown; summary?: unknown } } | null)?.error;
  const summary = typeof error?.summary === 'string' ? error.summary : stdout.slice(0, MAX_QUOTED_OUTPUT);
  if (error?.code === 'E404' && summary.startsWith(NO_MATCH_SUMMARY)) {
    return [];
  }
  throw new Error(`${command} failed (exit ${exitCode}): ${summary}`);
}

/**
 * Finds the allowlisted advisories that a published release now fixes, where the exception did not already name it.
 *
 * pnpm 9 reported an advisory with no fix as patched "<0.0.0", so a fix arriving showed as the patched range
 * changing, which the drift check catches. pnpm 11 reports the vulnerable range turned inside out, ">=6.6.2" for
 * "<=6.6.1", which reads the same before and after 6.6.2 ships. So each allowlisted advisory the report still carries
 * is checked against the releases that exist.
 *
 * Advisories the allowlist does not cover, or covers for another package, fail on their own and are not looked up.
 * A lookup that cannot answer rejects, so the gate stops rather than passing on a question nobody answered.
 */
export async function findAvailableFixes(
  advisories: readonly Advisory[],
  allowlist: readonly AllowedAdvisory[],
  publishedVersionsIn: PublishedVersionsIn,
): Promise<GateFailure[]> {
  const failures: GateFailure[] = [];

  for (const advisory of advisories) {
    const entry = allowlist.find(
      (candidate) => candidate.ghsa === advisory.ghsa && candidate.packageName === advisory.packageName,
    );
    if (!entry) {
      continue;
    }

    const releases = await publishedVersionsIn(advisory.packageName, advisory.patchedVersions);
    const unreviewed = releases.filter((release) => !entry.reviewedFixReleases.includes(release));
    if (unreviewed.length === 0) {
      continue;
    }

    const detail =
      `Published releases satisfy its patched range ${advisory.patchedVersions} that the exception did not know ` +
      `of: ${unreviewed.join(', ')}. Upgrade to one, or re-read the reason and name them in reviewedFixReleases ` +
      'before keeping the entry.';
    failures.push({ kind: 'fix-available', ghsa: advisory.ghsa, packageName: advisory.packageName, detail });
  }

  return failures;
}
