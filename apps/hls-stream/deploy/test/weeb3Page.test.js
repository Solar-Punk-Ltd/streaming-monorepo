import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_WEEB3_PAGE, weeb3Page } from '../scripts/weeb3-page.mjs';

/**
 * The in-browser scripts drive a weeb-3 app page, and which one is a setting: a pinned or
 * self-hosted build is measured by naming its page in WEEB3_PAGE, with weeb-3's own published
 * deployment as the documented default.
 */
describe('weeb3Page', () => {
  it('answers the published deployment when nothing is set', () => {
    assert.equal(weeb3Page({}), DEFAULT_WEEB3_PAGE);
    assert.equal(weeb3Page({ WEEB3_PAGE: '   ' }), DEFAULT_WEEB3_PAGE);
  });

  it('answers the page the setting names', () => {
    assert.equal(weeb3Page({ WEEB3_PAGE: 'https://weeb3.example.com/app/' }), 'https://weeb3.example.com/app/');
  });

  it('ends the page with a slash, because the scripts join paths onto it', () => {
    assert.equal(weeb3Page({ WEEB3_PAGE: 'https://weeb3.example.com/app' }), 'https://weeb3.example.com/app/');
  });

  it('refuses a value that is not an http or https address', () => {
    assert.throws(() => weeb3Page({ WEEB3_PAGE: 'not a url' }), /WEEB3_PAGE/);
    assert.throws(() => weeb3Page({ WEEB3_PAGE: 'file:///tmp/weeb3/' }), /WEEB3_PAGE/);
  });
});
