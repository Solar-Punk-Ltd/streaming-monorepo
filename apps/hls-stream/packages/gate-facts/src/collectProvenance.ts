import { introducedVersions, splitVersion } from './lockfileVersions.js';
import { describe, run } from './run.js';
import { CollectionError, type FactGroup } from './types.js';

/** Registry lookups are independent, and doing 200 of them one at a time is the slow way. */
const REGISTRY_CONCURRENCY = 12;

/**
 * The window of the owner's dependency rule, which flags a version published less than about two weeks
 * ago, so the fresh row lists the versions that rule flags.
 */
const FRESH_DAYS = 14;

const REGISTRY_TIMEOUT_MS = 60 * 1000;

/** Long lists are the normal case here, and pasting 120 specs into a pull request body helps nobody. */
const MAX_LISTED = 8;

/**
 * `unreadable` is a third state on purpose, and it is not a synonym for unsigned.
 *
 * A lookup that errors means the registry did not answer the question. Folding that into "not
 * signed" invents a security finding out of a network blip, and folding it into "signed" hides a
 * real one. Neither is acceptable, so it is reported as itself.
 */
type SignatureState = 'signed' | 'unsigned' | 'unreadable';

/** Age gets the same treatment, for the same reason. `null` means the date was never read. */
export interface VersionProvenance {
  spec: string;
  ageDays: number | null;
  signature: SignatureState;
  attested: boolean;
}

/**
 * The arguments for the provenance lookup, exported so a test can pin them.
 *
 * `dist` must be the ONLY field requested. Asking for two makes npm flatten the result to the top
 * level, so `.signatures` and `.attestations` come back undefined and every package in the tree
 * reports as unsigned. That is a named trap in the owner's dependency rule, and nothing but this
 * constant and its test stands between a future edit and reintroducing it.
 */
export function distArgs(spec: string): string[] {
  return ['view', spec, 'dist', '--json'];
}

async function readDist(spec: string): Promise<{ signature: SignatureState; attested: boolean }> {
  const result = await run('npm', distArgs(spec), REGISTRY_TIMEOUT_MS);
  try {
    const dist = JSON.parse(result.stdout) as {
      signatures?: unknown[];
      attestations?: { provenance?: unknown };
    };
    return {
      signature: Array.isArray(dist.signatures) && dist.signatures.length > 0 ? 'signed' : 'unsigned',
      attested: dist.attestations?.provenance !== undefined,
    };
  } catch {
    return { signature: 'unreadable', attested: false };
  }
}

/** Whole days elapsed between the registry's publish timestamp and `now`, or null when the date does not parse. */
export function wholeDaysSince(published: string, now: number): number | null {
  // A registry clock a few minutes ahead of this one is not a negative age.
  const days = Math.floor(Math.max(0, now - Date.parse(published)) / 86_400_000);
  // An unparseable date yields NaN, which loses every comparison and would drop the version out of
  // the fresh bucket while reporting nothing. Unknown is a state, not a number.
  return Number.isFinite(days) ? days : null;
}

async function readAgeDays(name: string, version: string): Promise<number | null> {
  const result = await run('npm', ['view', name, 'time', '--json'], REGISTRY_TIMEOUT_MS);
  try {
    const times = JSON.parse(result.stdout) as Record<string, string>;
    const published = times[version];
    if (!published) {
      return null;
    }
    return wholeDaysSince(published, Date.now());
  } catch {
    return null;
  }
}

async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  }
  return results;
}

async function provenanceFor(specs: readonly string[]): Promise<VersionProvenance[]> {
  return inBatches(specs, REGISTRY_CONCURRENCY, async (spec) => {
    const { name, version } = splitVersion(spec);
    const [ageDays, dist] = await Promise.all([readAgeDays(name, version), readDist(spec)]);
    return { spec, ageDays, ...dist };
  });
}

function list(entries: readonly VersionProvenance[], label: (e: VersionProvenance) => string): string {
  if (entries.length === 0) {
    return 'none';
  }
  const shown = entries.slice(0, MAX_LISTED).map(label);
  const remainder = entries.length - shown.length;
  // Say what was dropped. A truncated list that does not admit it reads as the whole set.
  return `${entries.length}: ${shown.join(', ')}${remainder > 0 ? `, and ${remainder} more` : ''}`;
}

interface ProvenanceSummary {
  introduced: string;
  unsigned: string;
  unreadable: string;
  ageUnknown: string;
  unattested: string;
  fresh: string;
  freshAndUnattested: string;
  /** True when something was not measured or came back bad, either of which needs a decision. */
  needsAttention: boolean;
}

export function summarise(entries: readonly VersionProvenance[]): ProvenanceSummary {
  const unsigned = entries.filter((e) => e.signature === 'unsigned');
  const unreadable = entries.filter((e) => e.signature === 'unreadable');
  const ageUnknown = entries.filter((e) => e.ageDays === null);
  const readable = entries.filter((e) => e.signature !== 'unreadable');
  const unattested = readable.filter((e) => !e.attested);
  const fresh = entries.filter((e) => e.ageDays !== null && e.ageDays < FRESH_DAYS);
  const withAge = (e: VersionProvenance) => `${e.spec} (${e.ageDays}d)`;
  const spec = (e: VersionProvenance) => e.spec;

  return {
    introduced: String(entries.length),
    unsigned: list(unsigned, spec),
    unreadable: list(unreadable, spec),
    ageUnknown: list(ageUnknown, spec),
    // Denominator counts only what was read. Dividing by the whole set implies the difference was
    // checked and found attested, when it was never checked at all.
    unattested: `${unattested.length} of ${readable.length} read${
      unattested.length > 0 ? `, ${list(unattested, spec)}` : ''
    }`,
    fresh: list(fresh, withAge),
    freshAndUnattested: list(
      fresh.filter((e) => !e.attested),
      withAge,
    ),
    needsAttention: unsigned.length > 0 || unreadable.length > 0 || ageUnknown.length > 0,
  };
}

/** Neither of these is collected here, and both are still owed on any lockfile change. */
const UNCOLLECTED_DEPENDENCY_CHECKS =
  '`npm audit signatures` (reads the installed tree, not the diff) and `gh api /advisories?type=malware`';

const LOCKFILE_NAME = 'pnpm-lock.yaml';

/** Each lockfile the repository tracks at one commit, by its path from the repository root. */
type Lockfiles = ReadonlyMap<string, string>;

/**
 * The arguments that list every file of the repository at `ref`. `--full-tree` because the tool runs from the
 * stack's folder, where a plain `ls-tree` lists that folder alone.
 */
function listingArgs(ref: string): string[] {
  return ['ls-tree', '-r', '--name-only', '--full-tree', ref];
}

function isLockfile(path: string): boolean {
  return path === LOCKFILE_NAME || path.endsWith(`/${LOCKFILE_NAME}`);
}

/** One lockfile's text at `ref`. A bare path after `ref:` is read from the repository root, which is how it is listed. */
function lockfileShowArgs(ref: string, path: string): string[] {
  return ['show', `${ref}:${path}`];
}

/** Paths from the repository root, as pathspecs a command run from the stack's folder reads that way too. */
function fromRepositoryRoot(paths: Iterable<string>): string[] {
  return [...paths].map((path) => `:/${path}`);
}

function sameLockfiles(left: Lockfiles, right: Lockfiles): boolean {
  return left.size === right.size && [...left].every(([path, text]) => right.get(path) === text);
}

/** Every version any of the lockfiles pins, as one text `introducedVersions` reads the way it reads one lockfile. */
function allVersions(lockfiles: Lockfiles): string {
  return [...lockfiles.values()].join('\n');
}

/**
 * Publish age, signature and SLSA provenance for every version this change introduces, into any lockfile of the
 * repository.
 *
 * Every lockfile the repository tracks is read, not only the stack's: the root one since the repository became one
 * workspace, each app's own before. The owner's dependency rule covers every version a change introduces, and in
 * one workspace a stack change can bring versions that only another app reaches, through a root override or a
 * changed dedupe. Comparing the union of versions also reads a change across that move correctly: the apps' three
 * lockfiles becoming one at the root introduces nothing that was already pinned.
 *
 * The lockfiles are compared from the merge base, the commit the change branched from, where the diff rows start as
 * well. Compared from the base's tip, a package the base bumped after the change branched off it would read as a
 * version this change introduced.
 *
 * Returns null when the change moved no lockfile. A failed read is a thrown `CollectionError` rather than a null,
 * because "no dependency changed" and "I could not tell" must not render the same.
 *
 * This covers two of the owner's four dependency checks. The other two are named in the artifact rather than left
 * out silently, because a section that lists some checks reads as listing all of them, and the auditor is told not
 * to re-derive what the block already emits.
 */
export async function collectProvenance(base: string, head: string): Promise<FactGroup | null> {
  const git = async (args: string[]): Promise<string> => {
    const result = await run('git', args);
    if (result.exitCode !== 0) {
      throw new CollectionError(describe('git', args), result.stderr.trim() || `exit ${result.exitCode}`);
    }
    return result.stdout;
  };
  const lockfilesAt = async (ref: string): Promise<Lockfiles> => {
    const paths = (await git(listingArgs(ref))).split('\n').filter(isLockfile).sort();
    return new Map(
      await Promise.all(paths.map(async (path) => [path, await git(lockfileShowArgs(ref, path))] as const)),
    );
  };

  const branchPoint = (await git(['merge-base', base, head])).trim();
  const branchPointLockfiles = await lockfilesAt(branchPoint);
  const headLockfiles = await lockfilesAt(head);
  if (sameLockfiles(branchPointLockfiles, headLockfiles)) {
    // The group is absent only when the change left every lockfile untouched. A lockfile that moved and
    // introduced nothing is a different fact and gets a row saying so, because an absent group and a
    // clean one would otherwise read the same.
    return null;
  }

  const introduced = introducedVersions(allVersions(branchPointLockfiles), allVersions(headLockfiles));
  if (introduced.length === 0) {
    const everyLockfile = new Set([...branchPointLockfiles.keys(), ...headLockfiles.keys()]);
    return {
      title: 'Provenance of introduced versions',
      facts: [
        {
          key: 'versions introduced',
          value: '0, though the lockfile did change. Nothing new resolved, so there is nothing to check.',
          // Three dots, so the diff a reader runs starts from the merge base the lockfiles were compared from.
          command: describe('git', [
            'diff',
            `${base}...${head}`,
            '--',
            ...fromRepositoryRoot([...everyLockfile].sort()),
          ]),
        },
      ],
    };
  }

  const summary = summarise(await provenanceFor(introduced));
  const command = describe('npm', distArgs('<pkg>@<ver>'));

  return {
    title: 'Provenance of introduced versions',
    facts: [
      {
        key: 'versions introduced',
        value: summary.introduced,
        command: describe('git', ['show', ...[...headLockfiles.keys()].map((path) => `${head}:${path}`)]),
      },
      { key: 'unsigned', value: summary.unsigned, command, failed: summary.unsigned !== 'none' },
      { key: 'registry lookup failed', value: summary.unreadable, command, failed: summary.unreadable !== 'none' },
      {
        key: 'publish date not read',
        value: summary.ageUnknown,
        command: describe('npm', ['view', '<pkg>', 'time', '--json']),
        failed: summary.ageUnknown !== 'none',
      },
      { key: 'without SLSA provenance', value: summary.unattested, command },
      {
        key: `published under ${FRESH_DAYS} days ago`,
        value: summary.fresh,
        command: describe('npm', ['view', '<pkg>', 'time', '--json']),
      },
      { key: 'fresh AND unattested', value: summary.freshAndUnattested, command },
      {
        key: 'NOT collected here, still owed',
        value: UNCOLLECTED_DEPENDENCY_CHECKS,
        command: 'run both by hand on any lockfile change',
      },
    ],
  };
}
