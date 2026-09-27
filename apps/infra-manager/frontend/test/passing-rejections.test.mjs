import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passingRejections } from './support/passing-rejections.mjs';

test('a dev-server middleware that rejects hands the error to next, which answers it', async () => {
  const failure = new Error('the body was not JSON');
  const handed = await new Promise((resolve) => {
    passingRejections(async () => {
      throw failure;
    })({}, {}, resolve);
  });

  assert.equal(handed, failure);
});
