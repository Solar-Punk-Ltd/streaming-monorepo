/**
 * Which repositories a manager builds stack versions from.
 *
 * Unit test, no database and no git. STACK_SOURCES is an allow-list of https
 * clone addresses, each with the folder of that repository the stack sits in.
 * Unset, it lists the upstream monorepo first and the stack's earlier
 * repository second, which is what every existing version row names. A fork
 * lists its own repository first, and new versions are added from there.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_STACK_SOURCES,
  MONOREPO_STACK_SOURCE,
  parseStackSources,
  STACK_IMPORT_HEAD,
  stackSourceAt,
  SWARM_HLS_STREAM_SOURCE,
} from '../../src/domain/versions/stackSources.js';

const FORK = 'https://github.com/example/streaming-monorepo.git';

describe('parseStackSources', () => {
  it('answers the upstream repositories when nothing is set', () => {
    for (const raw of [undefined, '', '   ']) {
      assert.deepEqual(parseStackSources(raw), DEFAULT_STACK_SOURCES);
    }
    assert.deepEqual(DEFAULT_STACK_SOURCES, [MONOREPO_STACK_SOURCE, SWARM_HLS_STREAM_SOURCE]);
  });

  it('reads a bare address as a repository laid out like this one', () => {
    assert.deepEqual(parseStackSources(FORK), [
      { url: FORK, folder: 'apps/hls-stream', historyHead: STACK_IMPORT_HEAD },
    ]);
  });

  it('reads a folder after #, and the whole tree as one with no earlier history', () => {
    assert.deepEqual(parseStackSources(` ${FORK}#apps/stream , https://github.com/example/swarm-hls-stream.git#. `), [
      { url: FORK, folder: 'apps/stream', historyHead: STACK_IMPORT_HEAD },
      { url: 'https://github.com/example/swarm-hls-stream.git', folder: '.', historyHead: null },
    ]);
  });

  it('refuses an address the build and the database would refuse', () => {
    for (const raw of [
      'http://github.com/example/repo.git',
      'https://gitlab.com/example/repo.git',
      'https://github.com/example/repo',
      'git@github.com:example/repo.git',
    ]) {
      assert.throws(() => parseStackSources(raw), /STACK_SOURCES/, raw);
    }
  });

  it('refuses a folder that is not . or a relative folder of plain names', () => {
    for (const folder of ['', '/abs', '../up', 'a/../b', 'a//b', '-x']) {
      assert.throws(() => parseStackSources(`${FORK}#${folder}`), /STACK_SOURCES/, folder);
    }
  });

  it('refuses an empty entry and a repository listed twice', () => {
    assert.throws(() => parseStackSources(`${FORK},,${SWARM_HLS_STREAM_SOURCE.url}`), /STACK_SOURCES/);
    assert.throws(() => parseStackSources(`${FORK},${FORK}#.`), /STACK_SOURCES.*twice/);
  });
});

describe('stackSourceAt', () => {
  it('answers a listed repository and null for any other', () => {
    const sources = parseStackSources(FORK);
    assert.equal(stackSourceAt(FORK, sources)?.url, FORK);
    assert.equal(stackSourceAt(MONOREPO_STACK_SOURCE.url, sources), null);
    assert.equal(stackSourceAt(MONOREPO_STACK_SOURCE.url)?.url, MONOREPO_STACK_SOURCE.url);
  });
});
