import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  FEED_STATE_DEGRADED,
  FEED_STATE_ENDED,
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
  type FeedState,
} from '../src/components/SwarmHlsPlayer/feedState';
import { FeedStateOverlay } from '../src/components/SwarmHlsPlayer/overlays/feed/FeedStateOverlay';

/** The overlay's own output, which a function component returns without needing anything to mount. */
function render(state: FeedState): ReactElement {
  const rendered = FeedStateOverlay({ state });
  if (!isValidElement(rendered)) {
    throw new Error(`the overlay rendered nothing at all for ${state}`);
  }
  return rendered;
}

function propsOf(element: ReactElement): { role?: string; 'aria-live'?: string; children?: unknown[] } {
  return element.props;
}

function textOf(element: ReactElement): string {
  return (propsOf(element).children ?? []).filter((child) => typeof child === 'string').join('');
}

describe('FeedStateOverlay', () => {
  it('shows nothing while the feed is live, which is nearly all of the time', () => {
    assert.equal(FeedStateOverlay({ state: FEED_STATE_LIVE }), null);
  });

  it('says the player is reconnecting when the gateway is not answering', () => {
    assert.match(textOf(render(FEED_STATE_RECONNECTING)), /Reconnecting/);
  });

  // Two messages rather than one. A gateway that is not answering usually comes back on its own; a
  // feed that has stopped advancing while its gateway answers usually does not, and telling a viewer
  // the player is reconnecting when it is connected fine points them at the wrong thing.
  it('says something different when the gateway answers but the feed is not advancing', () => {
    const stalled = textOf(render(FEED_STATE_STALLED));

    assert.notEqual(stalled, '');
    assert.notEqual(stalled, textOf(render(FEED_STATE_RECONNECTING)));
  });

  /**
   * The class names are the whole styling contract. `FeedStateOverlay.scss` keys the absolute
   * positioning, the backdrop, the colour and the pulsing dot off these two, so renaming either
   * renders the message as unstyled text in the document flow, in the exact situation the overlay
   * exists for. Nothing asserted them, and `renderToStaticMarkup` needs no DOM.
   */
  it('keeps the class names its stylesheet is written against', () => {
    const html = renderToStaticMarkup(render(FEED_STATE_RECONNECTING));

    assert.match(html, /class="swarm-hls-feed-state"/);
    assert.match(html, /class="swarm-hls-feed-state__dot"/);
  });

  it('says the broadcast has ended, distinctly from the two states that recover', () => {
    const ended = textOf(render(FEED_STATE_ENDED));

    assert.match(ended, /ended/i);
    assert.notEqual(ended, textOf(render(FEED_STATE_RECONNECTING)));
    assert.notEqual(ended, textOf(render(FEED_STATE_STALLED)));
  });

  /**
   * The dot pulses, which reads as something still being attempted. An ended broadcast is the one
   * state here where nothing is, and showing the pulse would promise a picture that is not coming.
   */
  it('drops the pulsing dot once the broadcast has ended', () => {
    assert.doesNotMatch(renderToStaticMarkup(render(FEED_STATE_ENDED)), /swarm-hls-feed-state__dot/);
    assert.match(renderToStaticMarkup(render(FEED_STATE_ENDED)), /class="swarm-hls-feed-state"/);
  });

  it('announces itself to a screen reader without stealing focus', () => {
    const props = propsOf(render(FEED_STATE_RECONNECTING));

    assert.equal(props.role, 'status');
    assert.equal(props['aria-live'], 'polite');
  });

  /**
   * The state added for the fourteen-minute collapse, where the gateway answered everything asked of
   * it and the picture stopped every couple of seconds anyway. Telling that viewer the player is
   * reconnecting or waiting on the broadcaster points them at two things that are both fine.
   */
  it('says the stream is struggling, distinctly from a gateway that is absent or empty', () => {
    const degraded = textOf(render(FEED_STATE_DEGRADED));

    assert.notEqual(degraded, '');
    for (const other of [FEED_STATE_RECONNECTING, FEED_STATE_STALLED, FEED_STATE_ENDED]) {
      assert.notEqual(degraded, textOf(render(other)));
    }
  });

  /** Something is still being attempted, and unlike the other two recoverable states it is playing. */
  it('keeps the pulsing dot while the stream is struggling', () => {
    assert.match(renderToStaticMarkup(render(FEED_STATE_DEGRADED)), /swarm-hls-feed-state__dot/);
  });

  /**
   * Every state but `live` reaches `MESSAGE`, and a missing key renders the overlay's chrome around
   * nothing: a backdrop and a pulsing dot over the picture, saying less than showing nothing would.
   */
  it('has a message for every state that is not live', () => {
    for (const state of [FEED_STATE_RECONNECTING, FEED_STATE_STALLED, FEED_STATE_ENDED, FEED_STATE_DEGRADED]) {
      assert.notEqual(textOf(render(state)), '', `${state} rendered an empty overlay`);
    }
  });
});
