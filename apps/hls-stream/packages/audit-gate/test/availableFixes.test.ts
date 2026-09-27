import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findAvailableFixes, parseNpmViewVersions } from '../src/availableFixes.js';
import { Advisory, AllowedAdvisory } from '../src/types.js';

/**
 * GHSA-848j-6mx2-7j84 as pnpm 11.11.0 reports it. No elliptic release fixes it, the newest being 6.6.1, yet the
 * patched range reads ">=6.6.2", the vulnerable range "<=6.6.1" turned inside out. pnpm 9.12.0 reported "<0.0.0".
 */
const ELLIPTIC: Advisory = {
  ghsa: 'GHSA-848j-6mx2-7j84',
  packageName: 'elliptic',
  severity: 'low',
  title: 'Elliptic Uses a Cryptographic Primitive with a Risky Implementation',
  patchedVersions: '>=6.6.2',
};

const ELLIPTIC_ENTRY: AllowedAdvisory = {
  ghsa: 'GHSA-848j-6mx2-7j84',
  packageName: 'elliptic',
  reviewedSeverity: 'low',
  reviewedPatchedVersions: '>=6.6.2',
  reviewedFixReleases: [],
  reason: 'No release fixes it anywhere.',
};

/** A registry that answers from `published`, keyed `<package>@<range>`, and records every question it was asked. */
function registry(published: Record<string, string[]>) {
  const asked: string[] = [];
  const lookUp = async (packageName: string, range: string): Promise<string[]> => {
    const spec = `${packageName}@${range}`;
    asked.push(spec);
    const versions = published[spec];
    if (versions === undefined) {
      throw new Error(`the test registry was asked about ${spec}, which it does not know`);
    }
    return versions;
  };
  return { asked, lookUp };
}

describe('findAvailableFixes', () => {
  it('finds no fix while no release satisfies the patched range pnpm 11 reports for elliptic', async () => {
    const { asked, lookUp } = registry({ 'elliptic@>=6.6.2': [] });

    assert.deepEqual(await findAvailableFixes([ELLIPTIC], [ELLIPTIC_ENTRY], lookUp), []);
    assert.deepEqual(asked, ['elliptic@>=6.6.2']);
  });

  it('fails an allowlisted advisory once a published release satisfies its patched range', async () => {
    const { lookUp } = registry({ 'elliptic@>=6.6.2': ['6.6.2'] });

    const failures = await findAvailableFixes([ELLIPTIC], [ELLIPTIC_ENTRY], lookUp);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'fix-available');
    assert.equal(failures[0].ghsa, 'GHSA-848j-6mx2-7j84');
    assert.equal(failures[0].packageName, 'elliptic');
    assert.match(failures[0].detail, />=6\.6\.2/);
    assert.match(failures[0].detail, /6\.6\.2\b/);
  });

  it('names every release that satisfies the range', async () => {
    const { lookUp } = registry({ 'elliptic@>=6.6.2': ['6.6.2', '6.7.0'] });

    const [failure] = await findAvailableFixes([ELLIPTIC], [ELLIPTIC_ENTRY], lookUp);

    assert.match(failure.detail, /6\.6\.2, 6\.7\.0/);
  });

  it('lets through a fixing release the exception already knew of when it was written', async () => {
    const knownFix = { ...ELLIPTIC_ENTRY, reviewedFixReleases: ['7.0.0'], reason: 'The fix is a major the chain cannot take.' };
    const { lookUp } = registry({ 'elliptic@>=6.6.2': ['7.0.0'] });

    assert.deepEqual(await findAvailableFixes([ELLIPTIC], [knownFix], lookUp), []);
  });

  it('fails on a fixing release that appeared since the exception was written, and names only that one', async () => {
    const knownFix = { ...ELLIPTIC_ENTRY, reviewedFixReleases: ['7.0.0'], reason: 'The fix is a major the chain cannot take.' };
    const { lookUp } = registry({ 'elliptic@>=6.6.2': ['6.6.3', '7.0.0'] });

    const [failure, ...rest] = await findAvailableFixes([ELLIPTIC], [knownFix], lookUp);

    assert.deepEqual(rest, []);
    assert.equal(failure.kind, 'fix-available');
    assert.match(failure.detail, /did not know of: 6\.6\.3\. /);
  });

  it('finds no fix for the "<0.0.0" pnpm 9 reported, which no release can satisfy', async () => {
    const underPnpm9 = { ...ELLIPTIC, patchedVersions: '<0.0.0' };
    const { asked, lookUp } = registry({ 'elliptic@<0.0.0': [] });

    assert.deepEqual(await findAvailableFixes([underPnpm9], [{ ...ELLIPTIC_ENTRY, reviewedPatchedVersions: '<0.0.0' }], lookUp), []);
    assert.deepEqual(asked, ['elliptic@<0.0.0']);
  });

  it('asks nothing about an advisory the allowlist does not cover, which fails as unreviewed anyway', async () => {
    const leftPad: Advisory = { ...ELLIPTIC, ghsa: 'GHSA-zzzz-zzzz-zzzz', packageName: 'left-pad' };
    const { asked, lookUp } = registry({});

    assert.deepEqual(await findAvailableFixes([leftPad], [ELLIPTIC_ENTRY], lookUp), []);
    assert.deepEqual(asked, []);
  });

  it('asks nothing about an advisory allowlisted for another package, which fails as a mismatch anyway', async () => {
    const elsewhere: Advisory = { ...ELLIPTIC, packageName: 'secp256k1' };
    const { asked, lookUp } = registry({});

    assert.deepEqual(await findAvailableFixes([elsewhere], [ELLIPTIC_ENTRY], lookUp), []);
    assert.deepEqual(asked, []);
  });

  it('stops rather than passing when the registry cannot answer', async () => {
    const lookUp = async (): Promise<string[]> => {
      throw new Error('npm view elliptic@>=6.6.2 version --json failed: ECONNRESET');
    };

    await assert.rejects(findAvailableFixes([ELLIPTIC], [ELLIPTIC_ENTRY], lookUp), /ECONNRESET/);
  });
});

/** What npm 10 printed for `npm view <spec> version --json`, recorded 2026-09-27. */
const NO_MATCH = JSON.stringify(
  {
    error: {
      code: 'E404',
      summary: 'No match found for version >=6.6.2',
      detail: "'elliptic@>=6.6.2' is not in this registry.\n\nNote that you can also install from a\ntarball, folder, http url, or git url.",
    },
  },
  null,
  2,
);
const NO_SUCH_PACKAGE = JSON.stringify(
  {
    error: {
      code: 'E404',
      summary: 'Not Found - GET https://registry.npmjs.org/no-such-package-q7x9z - Not found',
      detail: "'no-such-package-q7x9z@>=1.0.0' is not in this registry.",
    },
  },
  null,
  2,
);

describe('parseNpmViewVersions', () => {
  it('reads one matching release, which npm prints as a single string', () => {
    assert.deepEqual(parseNpmViewVersions(0, '"6.6.1"', 'elliptic@>=6.6.1'), ['6.6.1']);
  });

  it('reads several matching releases, which npm prints as a list', () => {
    assert.deepEqual(parseNpmViewVersions(0, '[\n  "6.6.0",\n  "6.6.1"\n]', 'elliptic@>=6.6.0'), ['6.6.0', '6.6.1']);
  });

  it('reads "no match found for version" as no release at all', () => {
    assert.deepEqual(parseNpmViewVersions(1, NO_MATCH, 'elliptic@>=6.6.2'), []);
  });

  it('refuses a package the registry does not know, which is not the same as no fix', () => {
    assert.throws(() => parseNpmViewVersions(1, NO_SUCH_PACKAGE, 'no-such-package-q7x9z@>=1.0.0'), /no-such-package-q7x9z@>=1\.0\.0/);
  });

  it('refuses a failure that printed no JSON', () => {
    assert.throws(() => parseNpmViewVersions(1, '', 'elliptic@>=6.6.2'), /elliptic@>=6\.6\.2/);
  });

  it('refuses a success that is not a version or a list of them', () => {
    assert.throws(() => parseNpmViewVersions(0, '{"version":"6.6.1"}', 'elliptic@>=6.6.1'), /elliptic@>=6\.6\.1/);
  });
});
