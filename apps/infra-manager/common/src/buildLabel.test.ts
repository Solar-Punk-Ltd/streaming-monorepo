/**
 * What a build's release may be called, and how every page shows one.
 * `pnpm test` in common/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLabelText, isBuildLabel } from './buildLabel.js';

const COMMIT = '635b4e1753cd35d06191fdd54a1f426f7478d438';

describe('what a label may be', () => {
  it('takes every shape a deploy names a build with', () => {
    for (const label of [
      'QA-build-2026-10-07',
      'QA-build-2026-10-07+3',
      '635b4e175',
      '635b4e175-dirty',
      'QA-build-2026-10-07+3-dirty',
      'release/2026.10_rc',
      'x'.repeat(96),
    ]) {
      assert.equal(isBuildLabel(label), true, label);
    }
  });

  it('refuses what a shell or a page would have to quote, an empty one, a long one, and no string at all', () => {
    for (const label of ['', 'x'.repeat(97), 'two words', "it's", '$(touch-pwned)', 'a\nb', 'tag;rm', 'ä']) {
      assert.equal(isBuildLabel(label), false, JSON.stringify(label));
    }
    for (const value of [undefined, null, 7, ['v1'], { label: 'v1' }]) {
      assert.equal(isBuildLabel(value), false, JSON.stringify(value));
    }
  });
});

describe('how a page shows a label', () => {
  it('puts the first nine characters of the commit beside it, and the whole commit in the title', () => {
    assert.deepEqual(buildLabelText('QA-build-2026-10-07', COMMIT), {
      text: 'QA-build-2026-10-07 (635b4e175)',
      title: COMMIT,
    });
    assert.deepEqual(buildLabelText('QA-build-2026-10-07+3', COMMIT), {
      text: 'QA-build-2026-10-07+3 (635b4e175)',
      title: COMMIT,
    });
  });

  it('shows a label that already starts with those nine characters alone', () => {
    assert.deepEqual(buildLabelText('635b4e175', COMMIT), { text: '635b4e175', title: COMMIT });
    assert.deepEqual(buildLabelText('635b4e175-dirty', COMMIT), { text: '635b4e175-dirty', title: COMMIT });
  });

  it('shows the commit beside a label that names another one', () => {
    assert.equal(buildLabelText('0123456789', COMMIT).text, '0123456789 (635b4e175)');
  });

  it('shows the label alone, with no title, when the commit is not known', () => {
    assert.deepEqual(buildLabelText('QA-build-2026-10-07', null), { text: 'QA-build-2026-10-07', title: undefined });
    assert.deepEqual(buildLabelText('QA-build-2026-10-07', undefined), {
      text: 'QA-build-2026-10-07',
      title: undefined,
    });
  });
});
