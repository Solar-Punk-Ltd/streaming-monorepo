/**
 * The name of a manager instance, which the sidebar shows beside the build it runs.
 *
 * Unit test. `pnpm test` in common/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INSTANCE_NAME_MAX_LENGTH, instanceName } from './instanceName.js';

describe('the name of a manager instance', () => {
  it('takes letters, digits, dots, dashes and underscores, trimmed', () => {
    assert.equal(instanceName('swarm-dev'), 'swarm-dev');
    assert.equal(instanceName('  qa_1.eu  '), 'qa_1.eu');
  });

  it('is null when it is unset or blank', () => {
    for (const empty of [undefined, null, '', '   ']) assert.equal(instanceName(empty), null);
  });

  it('is null for anything of another shape', () => {
    for (const bad of [
      'swarm dev',
      'swarm/dev',
      '<b>dev</b>',
      'dev;',
      42,
      {},
      'a'.repeat(INSTANCE_NAME_MAX_LENGTH + 1),
    ]) {
      assert.equal(instanceName(bad), null, String(bad));
    }
    assert.equal(instanceName('a'.repeat(INSTANCE_NAME_MAX_LENGTH)), 'a'.repeat(INSTANCE_NAME_MAX_LENGTH));
    assert.equal(INSTANCE_NAME_MAX_LENGTH, 40);
  });
});
