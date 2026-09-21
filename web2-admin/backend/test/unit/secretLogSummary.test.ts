import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { secretLogSummary } from '../../src/utils/secretLogSummary.js';

describe('secretLogSummary', () => {
  it('reports only presence and length without any credential substring', () => {
    const credential = 'SENTINEL-private-credential';
    const summary = secretLogSummary(credential);

    assert.equal(summary, `(configured, ${String(credential.length)} chars)`);
    assert.equal(summary.includes('SENTINEL'), false);
    assert.equal(summary.includes(credential.slice(0, 6)), false);
  });

  it('reports an empty value as unset', () => {
    assert.equal(secretLogSummary(''), '(unset)');
  });

  it('reports a missing optional credential as unset instead of stopping the boot', () => {
    assert.equal(secretLogSummary(null), '(unset)');
    assert.equal(secretLogSummary(undefined), '(unset)');
  });
});
