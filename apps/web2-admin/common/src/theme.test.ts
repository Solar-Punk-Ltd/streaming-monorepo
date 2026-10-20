import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as common from './index.js';
import { ADMIN_THEME_NAMES, DEFAULT_ADMIN_THEME, isAdminThemeName } from './theme.js';

test('the console carries two looks, Swarm first and the fallback', () => {
  assert.deepEqual([...ADMIN_THEME_NAMES], ['swarm', 'web3privacy']);
  assert.equal(DEFAULT_ADMIN_THEME, 'swarm');
});

test('a look the console carries is a look name', () => {
  for (const name of ADMIN_THEME_NAMES) assert.equal(isAdminThemeName(name), true);
});

test('anything else is not, a retired look and a differently cased one included', () => {
  for (const value of ['retired', 'Swarm', '', ' swarm', null, undefined, 1, {}]) {
    assert.equal(isAdminThemeName(value), false, String(value));
  }
});

test('both sides read the looks from the package root', () => {
  assert.equal(common.isAdminThemeName, isAdminThemeName);
  assert.equal(common.ADMIN_THEME_NAMES, ADMIN_THEME_NAMES);
});
