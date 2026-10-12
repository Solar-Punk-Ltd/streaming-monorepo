/**
 * MANAGER_INSTANCE_NAME: the name this manager instance goes by, such as swarm-dev, which the sidebar shows beside
 * the build it runs.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * A value of another shape stops the manager rather than being dropped, as a malformed BEE_LOCAL_HOST does: the
 * deploy sets it, and a sidebar quietly showing no name would hide the typo that caused it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { managerInstanceName } from '../../src/utils/config.js';

describe('the name this manager instance goes by', () => {
  it('is none when the operator set nothing', () => {
    for (const empty of [undefined, '', '   ']) assert.equal(managerInstanceName(empty), null);
  });

  it('takes a short name of letters, digits, dots, dashes and underscores, trimmed', () => {
    assert.equal(managerInstanceName('swarm-dev'), 'swarm-dev');
    assert.equal(managerInstanceName('  qa_1.eu '), 'qa_1.eu');
  });

  it('stops the manager on any other shape, naming the variable and the rule', () => {
    for (const bad of ['swarm dev', 'swarm/dev', '<b>', 'a'.repeat(41)]) {
      assert.throws(() => managerInstanceName(bad), /^Error: MANAGER_INSTANCE_NAME must be at most 40 letters, digits/);
    }
  });
});
