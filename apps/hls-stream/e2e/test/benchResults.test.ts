import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BENCH_RESULTS_DEFAULT_DIR, benchResultsDir } from '../src/benchResults.js';
import { ROOT_DIR } from '../src/config.js';

describe('where a measurement run writes its results', () => {
  it('defaults to a folder under the checkout that git ignores', () => {
    assert.equal(benchResultsDir({}, '/srv/stack'), join('/srv/stack', BENCH_RESULTS_DEFAULT_DIR));
  });

  it('treats an empty setting as unset', () => {
    assert.equal(
      benchResultsDir({ BENCH_RESULTS_DIR: '' }, '/srv/stack'),
      join('/srv/stack', BENCH_RESULTS_DEFAULT_DIR),
    );
  });

  it('takes an absolute setting as it is', () => {
    assert.equal(benchResultsDir({ BENCH_RESULTS_DIR: '/data/results' }, '/srv/stack'), '/data/results');
  });

  it('resolves a relative setting against the checkout', () => {
    assert.equal(benchResultsDir({ BENCH_RESULTS_DIR: 'out/runs' }, '/srv/stack'), '/srv/stack/out/runs');
  });

  it('keeps the default out of git', () => {
    const ignored = readFileSync(join(ROOT_DIR, '.gitignore'), 'utf8').split('\n');
    assert.ok(
      ignored.includes(`/${BENCH_RESULTS_DEFAULT_DIR}/`),
      `.gitignore does not name /${BENCH_RESULTS_DEFAULT_DIR}/`,
    );
  });
});
