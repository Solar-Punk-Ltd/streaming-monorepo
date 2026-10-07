/**
 * The build a console names, from what the deploy built into the image, and how every console writes it.
 * `pnpm test` in common/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEVELOPMENT_BUILD, versionDisplay, versionInfo } from './versionInfo.js';

const COMMIT = '635b4e1753cd35d06191fdd54a1f426f7478d438';
const SHORT = '635b4e175';

describe('versionInfo', () => {
  it('keeps a label of version.mjs and a full commit as they are', () => {
    for (const label of ['QA-build-2026-10-07', 'QA-build-2026-10-07+3', SHORT, `${SHORT}-dirty`, 'release/2.0_rc.1']) {
      assert.deepEqual(versionInfo(label, COMMIT), { label, commit: COMMIT });
    }
    assert.deepEqual(versionInfo('a'.repeat(96), COMMIT).label, 'a'.repeat(96), 'the longest label version.mjs prints');
  });

  it('is null for each value that is not set', () => {
    assert.deepEqual(versionInfo(undefined, undefined), { label: null, commit: null });
    assert.deepEqual(versionInfo('', ''), { label: null, commit: null });
    assert.deepEqual(versionInfo(null, null), { label: null, commit: null });
  });

  it('is null for a label a shell or a page would have to quote, or one longer than version.mjs prints', () => {
    for (const label of ["v1';touch x;'", 'v1 2', 'v1$(id)', 'v1"', 'v1\n', ' v1', 'v1\\', 'a'.repeat(97)]) {
      assert.deepEqual(versionInfo(label, COMMIT), { label: null, commit: COMMIT }, JSON.stringify(label));
    }
  });

  it('is null for a commit that is not 40 lowercase hex digits, and keeps the label beside it', () => {
    for (const commit of [SHORT, COMMIT.toUpperCase(), `${COMMIT}0`, `${COMMIT.slice(0, 39)}g`, ` ${COMMIT}`, 42]) {
      assert.deepEqual(versionInfo('QA-build', commit), { label: 'QA-build', commit: null }, String(commit));
    }
  });
});

describe('versionDisplay', () => {
  it('is the tag and the short commit for a tagged build, the full commit its title', () => {
    assert.deepEqual(versionDisplay({ label: 'QA-build-2026-10-07', commit: COMMIT }), {
      text: `QA-build-2026-10-07 (${SHORT})`,
      title: COMMIT,
    });
  });

  it('is the nearest tag, the distance and the short commit for a build past a tag', () => {
    assert.equal(
      versionDisplay({ label: 'QA-build-2026-10-07+3', commit: COMMIT }).text,
      `QA-build-2026-10-07+3 (${SHORT})`,
    );
  });

  it('is the label alone for an untagged build, whose label is its short commit already', () => {
    assert.deepEqual(versionDisplay({ label: SHORT, commit: COMMIT }), { text: SHORT, title: COMMIT });
  });

  it('keeps -dirty where version.mjs put it, after the short commit or before it', () => {
    assert.deepEqual(versionDisplay({ label: `${SHORT}-dirty`, commit: COMMIT }), {
      text: `${SHORT}-dirty`,
      title: COMMIT,
    });
    assert.equal(
      versionDisplay({ label: 'QA-build-2026-10-07-dirty', commit: COMMIT }).text,
      `QA-build-2026-10-07-dirty (${SHORT})`,
    );
  });

  it('is a development build when no version is set', () => {
    assert.deepEqual(versionDisplay({ label: null, commit: null }), { text: DEVELOPMENT_BUILD, title: null });
    assert.deepEqual(versionDisplay({ label: null, commit: COMMIT }), { text: DEVELOPMENT_BUILD, title: COMMIT });
  });

  it('is the label alone when no commit is set beside it', () => {
    assert.deepEqual(versionDisplay({ label: 'QA-build-2026-10-07', commit: null }), {
      text: 'QA-build-2026-10-07',
      title: null,
    });
  });
});
