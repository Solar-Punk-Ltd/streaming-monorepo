import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'vitest';

import { WatchPlaceholder } from '../src/pages/StreamWatcher/WatchPlaceholder';
import {
  WATCH_VIEW_LOADING,
  WATCH_VIEW_NOT_STARTED,
  WATCH_VIEW_PLAYER,
  WATCH_VIEW_UNAVAILABLE,
  type WatchPageView,
} from '../src/utils/watchPageView';

const render = (view: WatchPageView, startsAt: string | null = null): string =>
  renderToStaticMarkup(createElement(WatchPlaceholder, { view, startsAt }));

/**
 * What the watch page says in place of the player. A shared link opens before the catalog has been read, and a first
 * read over a cold gateway takes a while, so the page says it is looking rather than showing nothing.
 */
describe('the watch page in place of the player', () => {
  it('says it is loading while the catalog has not been read', () => {
    assert.match(render(WATCH_VIEW_LOADING), /Loading this stream/);
  });

  it('says a scheduled stream has not started, with its start time when there is one', () => {
    const html = render(WATCH_VIEW_NOT_STARTED, '28 Sep, 20:00');
    assert.match(html, /This stream has not started yet\./);
    assert.match(html, /Scheduled for 28 Sep, 20:00/);
    assert.doesNotMatch(render(WATCH_VIEW_NOT_STARTED), /Scheduled for/);
  });

  it('says a stream that is gone is no longer available', () => {
    assert.match(render(WATCH_VIEW_UNAVAILABLE), /This stream is no longer available\./);
  });

  it('says nothing once the player is showing', () => {
    assert.equal(render(WATCH_VIEW_PLAYER), '');
  });
});
