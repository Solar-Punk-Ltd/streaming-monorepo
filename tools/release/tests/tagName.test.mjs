import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TAG_NAME_MAX_LENGTH, isSafeTagName, tagNameProblem } from '../lib/tagName.mjs';

describe('a tag name', () => {
  it('may follow any scheme within letters, digits and . _ + / -', () => {
    for (const name of [
      'QA-build-2026-10-07',
      'v2.4.0',
      'release/2026.10',
      'v1.0.0+build.5',
      '2026-10-07',
      'stack/v3.3',
    ]) {
      assert.equal(tagNameProblem(name), null, name);
    }
  });

  it('may not hold what a shell or a page would have to quote', () => {
    for (const name of ['a b', "x'y", 'x"y', '$(id)', 'a;b', 'a&b', 'a|b', 'a<b', 'a`b', 'a@{b', 'x~1', 'a:b']) {
      assert.equal(isSafeTagName(name), false, name);
    }
  });

  it('must start with a letter or a digit', () => {
    for (const name of ['-x', '.hidden', '/a', '_a', '+a']) assert.equal(isSafeTagName(name), false, name);
  });

  it('keeps out what git refuses in a ref name', () => {
    for (const name of ['a..b', 'a//b', 'a/.b', 'a.', 'a/', 'a.lock', 'a/b.lock/c']) {
      assert.equal(isSafeTagName(name), false, name);
    }
  });

  it('is never empty and never longer than the limit', () => {
    assert.equal(tagNameProblem(''), 'is empty');
    assert.equal(tagNameProblem(undefined), 'is empty');
    assert.equal(isSafeTagName('a'.repeat(TAG_NAME_MAX_LENGTH)), true);
    assert.match(tagNameProblem('a'.repeat(TAG_NAME_MAX_LENGTH + 1)), /longer than 80/);
  });
});
