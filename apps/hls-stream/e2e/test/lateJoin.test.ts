import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT_DIR } from '../src/config.js';
import {
  CLIENT_CATCH_UP_LIMIT_FACTOR,
  CLIENT_LIVE_SYNC_FLOOR_S,
  CLIENT_LIVE_SYNC_SEGMENTS,
  clientCatchUpLimitS,
  lateJoinRefusal,
} from '../src/harness/lateJoin.js';

const PLAYER_CONFIG = join(ROOT_DIR, 'packages', 'client', 'src', 'components', 'SwarmHlsPlayer', 'playerConfig.ts');

function declaredNumber(name: string): number | null {
  const match = new RegExp(`const ${name} = (\\d+(?:\\.\\d+)?);`).exec(readFileSync(PLAYER_CONFIG, 'utf8'));
  return match === null ? null : Number(match[1]);
}

describe('the client numbers the late-join bound is built from', () => {
  it('match the client', () => {
    assert.equal(declaredNumber('LIVE_SYNC_DURATION_S'), CLIENT_LIVE_SYNC_FLOOR_S);
    assert.equal(declaredNumber('LIVE_SYNC_SEGMENTS'), CLIENT_LIVE_SYNC_SEGMENTS);
    assert.equal(declaredNumber('CATCH_UP_LIMIT_FACTOR'), CLIENT_CATCH_UP_LIMIT_FACTOR);
  });

  it('follow the longer of the floor and three segments', () => {
    assert.equal(clientCatchUpLimitS(1), 12);
    assert.equal(clientCatchUpLimitS(4), 24);
  });
});

describe('lateJoinRefusal', () => {
  const window = { windowSeconds: 40, fragmentSeconds: 1 };

  it('refuses a player that started at the window first entry', () => {
    assert.match(lateJoinRefusal({ ...window, joinS: 40 }) ?? '', /past the client's 12s catch-up limit/);
  });

  it('passes a player that started where the client aims', () => {
    assert.equal(lateJoinRefusal({ ...window, joinS: 6.4 }), null);
  });

  it('refuses a missing reading and a window too short to tell the two starts apart', () => {
    assert.match(lateJoinRefusal({ ...window, joinS: null }) ?? '', /no position/);
    assert.match(lateJoinRefusal({ windowSeconds: 12, fragmentSeconds: 1, joinS: 6 }) ?? '', /cannot be told/);
  });
});
