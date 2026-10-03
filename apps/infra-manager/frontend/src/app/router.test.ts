/**
 * Which page a hash opens: the Stages page beside the ones that were there before it, and the overview for anything
 * the console does not know.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRoute, routes } from './router';

describe('the page a hash opens', () => {
  it('is the Stages page for its own hash, with or without a trailing slash', () => {
    assert.deepEqual(parseRoute(routes.stages), { page: 'stages' });
    assert.deepEqual(parseRoute('#/stages/'), { page: 'stages' });
  });

  it('keeps the pages beside it where they were', () => {
    assert.deepEqual(parseRoute(routes.deployments), { page: 'deployments' });
    assert.deepEqual(parseRoute(routes.deployment('stage-one')), {
      page: 'deployment',
      name: 'stage-one',
      focus: null,
    });
    assert.deepEqual(parseRoute(routes.host), { page: 'host' });
  });

  it('is the overview for no hash and for one it does not know', () => {
    assert.deepEqual(parseRoute(''), { page: 'overview' });
    assert.deepEqual(parseRoute(routes.overview), { page: 'overview' });
    assert.deepEqual(parseRoute('#/nowhere'), { page: 'overview' });
  });
});
