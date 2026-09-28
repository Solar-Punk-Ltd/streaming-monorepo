/**
 * The sign-in errors both backends throw and map to an answer.
 *
 * Each error handler tells them apart with `instanceof`, so the class has to be
 * the one the thrower used, and the name and message are what reach a log and,
 * for some, the response. Pinned so a change here is a change on purpose.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdminRequiredError,
  CannotRemoveUserError,
  CrossSiteRequestError,
  InvalidCredentialsError,
  InvalidUsernameError,
  UserExistsError,
  WeakPasswordError,
} from './errors/index.js';

describe('the sign-in errors', () => {
  it('say who may manage users', () => {
    const error = new AdminRequiredError();
    assert.equal(error.name, 'AdminRequiredError');
    assert.equal(error.message, 'Only a user who can manage users may do this.');
  });

  it('name the user that already exists', () => {
    const error = new UserExistsError('operator');
    assert.equal(error.name, 'UserExistsError');
    assert.equal(error.username, 'operator');
    assert.equal(error.message, 'User already exists: operator');
  });

  it('give one answer for an unknown user and a wrong password', () => {
    const error = new InvalidCredentialsError();
    assert.equal(error.name, 'InvalidCredentialsError');
    assert.equal(error.message, 'Wrong username or password');
  });

  it('prefix a cross-site refusal and keep its reason', () => {
    const error = new CrossSiteRequestError('the Origin header names another site');
    assert.equal(error.name, 'CrossSiteRequestError');
    assert.equal(error.reason, 'the Origin header names another site');
    assert.equal(error.message, 'Refused a cross-site request: the Origin header names another site');
  });

  it('carry the reason as the message for the three refusals an operator reads', () => {
    for (const [ErrorClass, name] of [
      [CannotRemoveUserError, 'CannotRemoveUserError'],
      [InvalidUsernameError, 'InvalidUsernameError'],
      [WeakPasswordError, 'WeakPasswordError'],
    ] as const) {
      const error = new ErrorClass('the reason');
      assert.equal(error.name, name);
      assert.equal(error.reason, 'the reason');
      assert.equal(error.message, 'the reason');
      assert.ok(error instanceof Error);
    }
  });
});
