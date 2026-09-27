/**
 * The rules every backend and console that signs in reads from here.
 *
 * The password rule is deliberately short: length, and not containing the
 * username. This pins the boundaries, because an off-by-one on the minimum is
 * the kind of thing nobody notices in review. The username rule is a copy of a
 * CHECK constraint in each auth migration, so it is pinned against the strings
 * the database would refuse. The lockout schedule is the whole brute-force
 * defence and every number in it is a decision someone could quietly change.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LAST_SEEN_REFRESH_MS,
  LOGIN_FIRST_LOCKOUT_MS,
  LOGIN_FORGET_MS,
  LOGIN_FREE_ATTEMPTS,
  LOGIN_MAX_LOCKOUT_MS,
  lockoutMsFor,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  REQUESTED_WITH_HEADER,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  USERNAME_MAX_LENGTH,
  USERNAME_MESSAGE,
  USERNAME_RE,
  usernameProblem,
} from './rules.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const USERNAME = 'operator';

describe('password policy', () => {
  it('accepts anything printable of the right length', () => {
    const fine = [
      'a'.repeat(PASSWORD_MIN_LENGTH),
      'a'.repeat(PASSWORD_MAX_LENGTH),
      'correct horse battery staple',
      '!"#$%&/()=?*<>|;:_-.,',
      'kávé és tejszínhab kérem',
    ];

    for (const password of fine) {
      assert.equal(passwordProblem(password, USERNAME), null, `should accept ${JSON.stringify(password)}`);
    }
  });

  it('refuses one character short of the minimum', () => {
    assert.match(passwordProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1), USERNAME) ?? '', /at least 12 characters/);
  });

  it('refuses one character past the maximum', () => {
    assert.match(passwordProblem('a'.repeat(PASSWORD_MAX_LENGTH + 1), USERNAME) ?? '', /at most 128 characters/);
  });

  it('refuses a password carrying the username, in any case', () => {
    for (const password of ['operator-is-my-name', 'my-name-is-OPERATOR-ok', 'xxxxOperatorxxxxx']) {
      assert.equal(
        passwordProblem(password, USERNAME),
        'password must not contain the username',
        `should refuse ${password}`,
      );
    }
  });

  it('reports length before it reports the username', () => {
    // A short password that also carries the username should say what the
    // operator will hit first, not the more surprising rule.
    assert.match(passwordProblem('operator', USERNAME) ?? '', /at least/);
  });
});

describe('username rules', () => {
  it('accepts what the database CHECK accepts', () => {
    for (const username of ['ab', 'operator', 'a.b_c-d', '0start', 'x'.repeat(USERNAME_MAX_LENGTH)]) {
      assert.equal(usernameProblem(username), null, `should accept ${username}`);
    }
  });

  it('refuses what the database CHECK refuses', () => {
    for (const username of [
      'a',
      'A',
      'Upper',
      'has space',
      '-lead',
      '.lead',
      'x'.repeat(USERNAME_MAX_LENGTH + 1),
      '',
    ]) {
      assert.ok(usernameProblem(username), `should refuse ${username}`);
    }
  });
});

describe('the lockout schedule', () => {
  it('is free up to the fourth failure', () => {
    for (let failures = 0; failures <= LOGIN_FREE_ATTEMPTS; failures += 1) {
      assert.equal(lockoutMsFor(failures), 0, `${failures} failures`);
    }
  });

  it('starts at a minute on the fifth and doubles, capped at an hour', () => {
    const minutes = [1, 2, 4, 8, 16, 32, 60, 60];

    minutes.forEach((expected, index) => {
      assert.equal(
        lockoutMsFor(LOGIN_FREE_ATTEMPTS + 1 + index),
        expected * 60 * 1000,
        `failure ${LOGIN_FREE_ATTEMPTS + 1 + index}`,
      );
    });
    assert.equal(lockoutMsFor(100), LOGIN_MAX_LOCKOUT_MS);
  });
});

describe('the numbers the backends share', () => {
  it('signs a session out after twelve idle hours or fourteen days, whichever comes first', () => {
    assert.equal(SESSION_IDLE_TIMEOUT_MS, 12 * HOUR_MS);
    assert.equal(SESSION_ABSOLUTE_TIMEOUT_MS, 14 * 24 * HOUR_MS);
  });

  it('writes last_seen_at at most once a minute', () => {
    assert.equal(LAST_SEEN_REFRESH_MS, MINUTE_MS);
  });

  it('locks for a minute first, an hour at most, and forgets after twice that', () => {
    assert.equal(LOGIN_FREE_ATTEMPTS, 4);
    assert.equal(LOGIN_FIRST_LOCKOUT_MS, MINUTE_MS);
    assert.equal(LOGIN_MAX_LOCKOUT_MS, HOUR_MS);
    assert.equal(LOGIN_FORGET_MS, 2 * HOUR_MS);
  });

  it('names the header a console puts on every write', () => {
    assert.equal(REQUESTED_WITH_HEADER, 'x-requested-with');
  });

  it('refuses a bad username with the message the pattern stands for', () => {
    assert.equal(usernameProblem('A'), USERNAME_MESSAGE);
    assert.equal(USERNAME_RE.source, '^[a-z0-9][a-z0-9._-]{1,31}$');
  });
});
