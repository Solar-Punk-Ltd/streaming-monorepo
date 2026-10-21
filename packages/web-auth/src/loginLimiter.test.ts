/**
 * The brute-force schedule.
 *
 * Unit test, no clock of its own: the limiter takes its `now`, so a test can
 * walk an hour forward without waiting. The numbers pinned here are the whole
 * defence, and each of them is a decision someone could quietly change: five
 * failures to the first lockout, one minute for it, doubling after that, an
 * hour's cap, and a right password wiping the count. The last cases are not
 * about the schedule at all: attempts still waiting on scrypt have to count, or
 * a burst sent together gets one free guess each.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  accountAtAddressKey,
  clientIpKey,
  confirmationKey,
  freeAttemptsFor,
  LoginLimiter,
  MAX_TRACKED_KEYS,
  passwordChangeKey,
  signInKeys,
  usernameKey,
  type AttemptKeys,
} from './LoginLimiter.js';
import { LOGIN_ACCOUNT_CEILING, LOGIN_FORGET_MS, LOGIN_FREE_ATTEMPTS } from './rules.js';

const MINUTE = 60 * 1000;
const KEY = accountAtAddressKey('operator', '192.0.2.1');

/** A limiter whose clock the test moves by hand. */
function limiterAt(start = 1_700_000_000_000) {
  const clock = { now: start };
  return {
    clock,
    limiter: new LoginLimiter(() => clock.now),
    advance(ms: number) {
      clock.now += ms;
    },
  };
}

/** One wrong password, start to finish. Returns the wait it was refused with. */
function wrongPassword(limiter: LoginLimiter, keys: AttemptKeys = { account: KEY }): number {
  const attempt = limiter.begin(keys);
  attempt.fail();
  return attempt.lockedForSeconds;
}

describe('LoginLimiter', () => {
  it('allows four failures without locking', () => {
    const { limiter } = limiterAt();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      assert.equal(wrongPassword(limiter), 0, `failure ${attempt} must not lock`);
    }
    assert.equal(limiter.retryAfterSeconds(KEY), 0);
  });

  it('locks for a minute on the fifth failure', () => {
    const { limiter } = limiterAt();

    for (let attempt = 1; attempt <= 5; attempt += 1) wrongPassword(limiter);

    assert.equal(limiter.retryAfterSeconds(KEY), 60);
  });

  it('doubles the wait on every further failure, up to an hour', () => {
    const { limiter, advance } = limiterAt();
    const expectedMinutes = [1, 2, 4, 8, 16, 32, 60, 60, 60];

    for (let attempt = 1; attempt <= 4; attempt += 1) wrongPassword(limiter);

    for (const minutes of expectedMinutes) {
      wrongPassword(limiter);
      assert.equal(limiter.retryAfterSeconds(KEY), minutes * 60, `expected a ${minutes} minute lockout`);
      // Wait it out, then fail again: the count keeps climbing.
      advance(minutes * MINUTE);
      assert.equal(limiter.retryAfterSeconds(KEY), 0);
    }
  });

  it('counts down while it is locked', () => {
    const { limiter, advance } = limiterAt();

    for (let attempt = 1; attempt <= 5; attempt += 1) wrongPassword(limiter);
    advance(20_000);
    assert.equal(limiter.retryAfterSeconds(KEY), 40);

    advance(39_999);
    assert.equal(limiter.retryAfterSeconds(KEY), 1);

    advance(1);
    assert.equal(limiter.retryAfterSeconds(KEY), 0);
  });

  it('forgets a key after two quiet hours', () => {
    const { limiter, advance } = limiterAt();

    for (let attempt = 1; attempt <= 5; attempt += 1) wrongPassword(limiter);
    advance(120 * MINUTE);

    // Back to a clean slate: four more failures must not lock again.
    for (let attempt = 1; attempt <= 4; attempt += 1) wrongPassword(limiter);
    assert.equal(limiter.retryAfterSeconds(KEY), 0);
  });

  it('wipes the account key when the password is finally right', () => {
    const { limiter } = limiterAt();
    for (let attempt = 1; attempt <= 4; attempt += 1) wrongPassword(limiter);

    limiter.begin({ account: KEY }).succeed();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      assert.equal(wrongPassword(limiter), 0, `failure ${attempt} after the reset`);
    }
  });

  it('takes a successful attempt back off the shared key', () => {
    const { limiter } = limiterAt();
    const address = clientIpKey('10.0.0.1');
    const keys = { account: KEY, shared: [address] };

    for (let attempt = 1; attempt <= 4; attempt += 1) wrongPassword(limiter, keys);
    limiter.begin(keys).succeed();

    // The account starts from zero again, and the address is left holding the
    // four failures it earned rather than five: the attempt that worked was
    // never one of them, and a reservation left behind would have locked it.
    assert.equal(limiter.retryAfterSeconds(KEY), 0);
    assert.equal(limiter.retryAfterSeconds(address), 0);

    wrongPassword(limiter, { account: accountAtAddressKey('mate', '10.0.0.1'), shared: [address] });
    assert.equal(limiter.retryAfterSeconds(address), 60);
  });

  it('counts the attempts that have not come back yet', () => {
    const { limiter } = limiterAt();

    // Five sign-ins waiting on scrypt and not one of them settled. This is the
    // shape of a burst sent all at once, and it used to see zero failures.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal(limiter.begin({ account: KEY }).lockedForSeconds, 0, `attempt ${attempt} should have been reserved`);
    }

    assert.equal(limiter.begin({ account: KEY }).lockedForSeconds, 60);
    assert.equal(limiter.retryAfterSeconds(KEY), 60);
  });

  it('stops growing at the cap, and keeps the newest key', () => {
    const { limiter, advance } = limiterAt();
    const newest = accountAtAddressKey('arrived-last', '192.0.2.1');

    // Usernames are whatever the caller sent, so this is a cheap thing for an
    // attacker to do and none of it may be forgotten for two hours.
    for (let n = 0; n < MAX_TRACKED_KEYS; n += 1) {
      wrongPassword(limiter, { account: accountAtAddressKey(`guess-${n}`, '192.0.2.1') });
      advance(1);
    }
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      wrongPassword(limiter, { account: newest });
    }

    assert.ok(
      limiter.trackedKeys() <= MAX_TRACKED_KEYS,
      `${limiter.trackedKeys()} keys held, the cap is ${MAX_TRACKED_KEYS}`,
    );
    assert.equal(limiter.retryAfterSeconds(newest), 60, 'the oldest keys go first, so the newest lockout survives');
  });

  it('keeps every key on its own count', () => {
    const { limiter } = limiterAt();
    const other = accountAtAddressKey('someone-else', '192.0.2.1');
    const ip = clientIpKey('10.0.0.1');

    for (let attempt = 1; attempt <= 5; attempt += 1) wrongPassword(limiter);

    assert.equal(limiter.retryAfterSeconds(KEY), 60);
    assert.equal(limiter.retryAfterSeconds(other), 0);
    assert.equal(limiter.retryAfterSeconds(ip), 0);
  });

  it('reads a username the same however it was capitalised', () => {
    assert.equal(usernameKey('Operator'), usernameKey('operator'));
    assert.notEqual(usernameKey('operator'), clientIpKey('operator'));
  });

  it('keeps a password change on a key of its own', () => {
    const { limiter } = limiterAt();
    const id = '00000000-0000-4000-8000-000000000001';

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      wrongPassword(limiter, { account: passwordChangeKey(id) });
    }

    // Guessing the current password locks the change, never the sign-in.
    assert.equal(limiter.retryAfterSeconds(passwordChangeKey(id)), 60);
    assert.equal(limiter.retryAfterSeconds(KEY), 0);
  });

  it('keys a password change on the user id, whichever kind the backend stores', () => {
    assert.equal(passwordChangeKey(7), 'password-change:7');
    assert.equal(
      passwordChangeKey('00000000-0000-4000-8000-000000000001'),
      'password-change:00000000-0000-4000-8000-000000000001',
    );
    assert.notEqual(passwordChangeKey(7), usernameKey('7'));
  });

  it('forgets a key no sooner than the rules say', () => {
    const { limiter, advance } = limiterAt();

    for (let attempt = 1; attempt <= 5; attempt += 1) wrongPassword(limiter);
    advance(LOGIN_FORGET_MS - 1);

    // One quiet millisecond short of forgetting, the count still stands: one
    // more failure is the sixth and locks for two minutes.
    wrongPassword(limiter);
    assert.equal(limiter.retryAfterSeconds(KEY), 120);
  });
});

/** `count` addresses, each its own, none sharing a /64. */
function addresses(count: number): string[] {
  return Array.from({ length: count }, (_, n) => `198.51.${Math.floor(n / 250)}.${(n % 250) + 1}`);
}

/** Fails one sign-in to `username` from each address in turn, `times` failures in all, at most 4 per address. */
function spreadFailures(limiter: LoginLimiter, username: string, times: number): string[] {
  const from = addresses(Math.ceil(times / 4));
  for (let n = 0; n < times; n += 1) {
    const attempt = limiter.begin(signInKeys(username, from[n % from.length]!));
    assert.equal(attempt.lockedForSeconds, 0, `failure ${n + 1} was let through`);
    attempt.fail();
  }
  return from;
}

describe("a key's free count belongs to the key", () => {
  it("gives the ceiling's key its own count, and every other key the usual one", () => {
    assert.equal(freeAttemptsFor(usernameKey('operator')), LOGIN_ACCOUNT_CEILING - 1);
    for (const key of [KEY, clientIpKey('192.0.2.1'), passwordChangeKey(7), confirmationKey(7)]) {
      assert.equal(freeAttemptsFor(key), LOGIN_FREE_ATTEMPTS, key);
    }
  });

  it("keeps the ceiling's count when its key is reserved as a plain string, as the account key or a shared one", () => {
    const { limiter } = limiterAt();
    const ceiling = usernameKey('operator');
    // As the account key: five failures, which would lock any other key, leave it free.
    for (let n = 0; n < 5; n += 1) wrongPassword(limiter, { account: ceiling });
    assert.equal(limiter.retryAfterSeconds(ceiling), 0);
    // As a shared key beside other accounts, up to the ceiling's 99: still free; the 100th locks.
    for (let n = 5; n < LOGIN_ACCOUNT_CEILING - 1; n += 1) {
      wrongPassword(limiter, { account: accountAtAddressKey(`user${n}`, '192.0.2.1'), shared: [ceiling] });
      assert.equal(limiter.retryAfterSeconds(ceiling), 0, `failure ${n + 1}`);
    }
    wrongPassword(limiter, { account: accountAtAddressKey('last', '192.0.2.1'), shared: [ceiling] });
    assert.equal(limiter.retryAfterSeconds(ceiling), 60);
  });
});

describe('release', () => {
  it('gives the attempt back on every key and wipes no earlier failure, the account key included', () => {
    const { limiter } = limiterAt();
    const address = clientIpKey('10.0.0.1');
    const keys = { account: KEY, shared: [address] };
    for (let n = 0; n < 4; n += 1) wrongPassword(limiter, keys);

    limiter.begin(keys).release();

    // Both keys still hold four: one more failure is the fifth on each, and locks both.
    assert.equal(limiter.retryAfterSeconds(KEY), 0);
    assert.equal(limiter.retryAfterSeconds(address), 0);
    wrongPassword(limiter, keys);
    assert.equal(limiter.retryAfterSeconds(KEY), 60);
    assert.equal(limiter.retryAfterSeconds(address), 60);
  });

  it('leaves nothing behind for an attempt that had no failures before it', () => {
    const { limiter } = limiterAt();
    limiter.begin({ account: KEY, shared: [clientIpKey('10.0.0.1')] }).release();
    assert.equal(limiter.trackedKeys(), 0);
  });
});

describe('the keys a sign-in counts on', () => {
  it('locks the account at one address after five failures, and leaves it free at another', () => {
    const { limiter } = limiterAt();
    for (let n = 0; n < 5; n += 1) limiter.begin(signInKeys('operator', '192.0.2.10')).fail();

    assert.ok(limiter.begin(signInKeys('operator', '192.0.2.10')).lockedForSeconds > 0);
    const elsewhere = limiter.begin(signInKeys('operator', '192.0.2.20'));
    assert.equal(elsewhere.lockedForSeconds, 0);
    elsewhere.succeed();
  });

  it('locks an address after five failures across several accounts', () => {
    const { limiter } = limiterAt();
    for (let n = 0; n < 5; n += 1) limiter.begin(signInKeys(`user${n}`, '192.0.2.10')).fail();

    assert.ok(limiter.begin(signInKeys('someone-else', '192.0.2.10')).lockedForSeconds > 0);
  });

  it(`frees 99 failures from many addresses, and locks every address at the ${LOGIN_ACCOUNT_CEILING}th`, () => {
    const { limiter } = limiterAt();
    const from = spreadFailures(limiter, 'operator', LOGIN_ACCOUNT_CEILING - 1);
    assert.ok(from.length >= 20, 'spread over at least twenty addresses');

    // A fresh address is still let in after 99, and a right password there takes back only its own attempt.
    const fresh = limiter.begin(signInKeys('operator', '203.0.113.1'));
    assert.equal(fresh.lockedForSeconds, 0);
    fresh.succeed();
    assert.equal(limiter.retryAfterSeconds(usernameKey('operator')), 0);

    const hundredth = limiter.begin(signInKeys('operator', '203.0.113.2'));
    assert.equal(hundredth.lockedForSeconds, 0);
    hundredth.fail();

    assert.equal(limiter.retryAfterSeconds(usernameKey('operator')), 60, 'the 100th locks for a minute');
    for (const ip of ['203.0.113.3', ...from.slice(0, 3)]) {
      assert.ok(limiter.begin(signInKeys('operator', ip)).lockedForSeconds > 0, ip);
    }
    const other = limiter.begin(signInKeys('someone-else', '203.0.113.3'));
    assert.equal(other.lockedForSeconds, 0, 'another account at a fresh address is not locked');
    other.succeed();
  });

  it("gives back only its own attempt on a right password elsewhere: the ceiling's count stands", () => {
    const { limiter } = limiterAt();
    spreadFailures(limiter, 'operator', LOGIN_ACCOUNT_CEILING - 2);

    limiter.begin(signInKeys('operator', '203.0.113.1')).succeed();

    // 98 failures still stand: two more, and the second of them locks.
    limiter.begin(signInKeys('operator', '203.0.113.2')).fail();
    assert.equal(limiter.retryAfterSeconds(usernameKey('operator')), 0);
    limiter.begin(signInKeys('operator', '203.0.113.3')).fail();
    assert.equal(limiter.retryAfterSeconds(usernameKey('operator')), 60);
  });

  it('keeps every earlier failure when an attempt is released after an error', () => {
    // An error after `begin` settles the attempt with release(), as both apps' sign-ins do: every key gives back
    // that attempt alone, and none of them is wiped, the account at that address included.
    const { limiter } = limiterAt();
    for (let n = 0; n < 3; n += 1) limiter.begin(signInKeys('operator', '192.0.2.10')).fail();
    spreadFailures(limiter, 'operator', LOGIN_ACCOUNT_CEILING - 5);

    limiter.begin(signInKeys('operator', '192.0.2.10')).release();

    // The account at that address still holds its three: a fourth is free, and the fifth locks it.
    const accountThere = { account: accountAtAddressKey('operator', '192.0.2.10') };
    wrongPassword(limiter, accountThere);
    assert.equal(limiter.retryAfterSeconds(accountThere.account), 0);
    wrongPassword(limiter, accountThere);
    assert.equal(limiter.retryAfterSeconds(accountThere.account), 60);

    // The address still holds its three: a fourth and a fifth from other accounts, and the fifth locks it.
    limiter.begin(signInKeys('user-a', '192.0.2.10')).fail();
    assert.equal(limiter.retryAfterSeconds(clientIpKey('192.0.2.10')), 0);
    limiter.begin(signInKeys('user-b', '192.0.2.10')).fail();
    assert.equal(limiter.retryAfterSeconds(clientIpKey('192.0.2.10')), 60);
    // The ceiling still holds its 98: two more, and the second locks.
    limiter.begin(signInKeys('operator', '203.0.113.2')).fail();
    assert.equal(limiter.retryAfterSeconds(usernameKey('operator')), 0);
    limiter.begin(signInKeys('operator', '203.0.113.3')).fail();
    assert.equal(limiter.retryAfterSeconds(usernameKey('operator')), 60);
  });

  it('counts two addresses in one /64 as one, and two /64s apart', () => {
    const { limiter } = limiterAt();
    for (let n = 0; n < 5; n += 1) limiter.begin(signInKeys('operator', `2001:db8:0:1::${n + 1}`)).fail();

    assert.ok(limiter.begin(signInKeys('operator', '2001:db8:0:1:ffff:ffff:ffff:ffff')).lockedForSeconds > 0);
    const otherNetwork = limiter.begin(signInKeys('operator', '2001:db8:0:2::1'));
    assert.equal(otherNetwork.lockedForSeconds, 0);
    otherNetwork.succeed();
    assert.equal(accountAtAddressKey('operator', '2001:db8:0:1::7'), 'account:operator@2001:db8:0:1::/64');
  });

  it('counts an IPv4-mapped IPv6 address as the IPv4 address', () => {
    const { limiter } = limiterAt();
    for (let n = 0; n < 5; n += 1) limiter.begin(signInKeys('operator', '::ffff:192.0.2.10')).fail();

    assert.ok(limiter.begin(signInKeys('operator', '192.0.2.10')).lockedForSeconds > 0);
    assert.equal(clientIpKey('::ffff:192.0.2.10'), clientIpKey('192.0.2.10'));
  });
});
