/**
 * Login throttle. Unit test — the clock is injected.
 *
 * Only failures count and a success clears the bucket: the operator who logs
 * in ten times an hour is not the one this is defending against.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LoginRateLimiter } from '../../src/domain/LoginRateLimiter.js';

const WINDOW_MS = 15 * 60 * 1000;

function limiterAt(clock: { now: number }): LoginRateLimiter {
  return new LoginRateLimiter(10, WINDOW_MS, () => clock.now);
}

describe('LoginRateLimiter', () => {
  it('allows up to ten failures, then refuses', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.check('admin');
      limiter.recordFailure('admin');
    }
    assert.throws(() => limiter.check('admin'), /Too many login attempts/);
  });

  it('counts per username', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.recordFailure('admin');
    }
    assert.throws(() => limiter.check('admin'));
    limiter.check('someone-else');
  });

  it('forgets failures older than the window', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.recordFailure('admin');
    }
    assert.throws(() => limiter.check('admin'));

    clock.now += WINDOW_MS + 1;
    limiter.check('admin');
  });

  it('reports how long to wait, rounded up to whole seconds', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.recordFailure('admin');
    }

    clock.now += WINDOW_MS - 1500;
    assert.throws(
      () => limiter.check('admin'),
      (err: unknown) =>
        err instanceof Error &&
        (err as { retryAfterSeconds?: number }).retryAfterSeconds === 2,
    );
  });

  it('caps the number of tracked usernames, evicting the oldest', () => {
    const clock = { now: 0 };
    const limiter = new LoginRateLimiter(10, WINDOW_MS, () => clock.now, 3);

    for (const username of ['a', 'b', 'c', 'd']) limiter.recordFailure(username);

    assert.equal(limiter.trackedUsernames, 3);
    // 'a' was pushed out; 'd', the one just recorded, is still there.
    limiter.check('a');
    for (let attempt = 1; attempt < 10; attempt += 1) limiter.recordFailure('d');
    assert.throws(() => limiter.check('d'));
  });

  it('never evicts the username it is recording', () => {
    const clock = { now: 0 };
    const limiter = new LoginRateLimiter(10, WINDOW_MS, () => clock.now, 1);

    limiter.recordFailure('first');
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.recordFailure('admin');

    assert.equal(limiter.trackedUsernames, 1);
    assert.throws(() => limiter.check('admin'), /Too many login attempts/);
  });

  it('stays bounded and fast under 5000 distinct usernames', () => {
    // The endpoint is unauthenticated, so this is the shape of an attack: a
    // fresh username every request. Eviction has to be O(1) — the sweep this
    // replaced blocked the event loop for seconds at 20k keys.
    const limiter = new LoginRateLimiter();
    const started = process.hrtime.bigint();
    for (let i = 0; i < 5_000; i += 1) limiter.recordFailure(`user-${i}`);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(limiter.trackedUsernames, 1_000, 'held at the cap');
    assert.ok(elapsedMs < 500, `5000 failures took ${elapsedMs.toFixed(0)}ms`);
  });

  it('clears the bucket on a successful login', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      limiter.recordFailure('admin');
    }
    limiter.clear('admin');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.check('admin');
      limiter.recordFailure('admin');
    }
    assert.throws(() => limiter.check('admin'));
  });
});
