import { Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { CatalogFeedReader } from '../src/utils/catalogFeed.js';
import type { TimedResponse } from '../src/utils/fetchWithTimeout.js';
import { GatewayClock } from '../src/utils/gatewayClock.js';

const GATEWAY_NOW_MS = Date.UTC(2026, 9, 7, 12, 0, 30);

describe('the gateway clock', () => {
  it('has no correction before any Date header has been seen', () => {
    const clock = new GatewayClock(() => GATEWAY_NOW_MS - 90_000);
    assert.equal(clock.offsetMs(), 0);
  });

  it('takes the offset of a viewer clock that runs behind from the Date header', () => {
    let viewerMs = GATEWAY_NOW_MS - 90_000;
    const clock = new GatewayClock(() => viewerMs);
    clock.noteResponse(new Headers({ date: new Date(GATEWAY_NOW_MS).toUTCString() }));

    // The header is whole seconds, so the gateway's instant is taken as the middle of that second.
    assert.equal(clock.offsetMs(), 90_500);
    viewerMs += 4_000;
    assert.equal(clock.offsetMs(), 90_500, 'the offset stays put as the viewer clock moves');
  });

  it('keeps the last offset when a response carries no Date or an unreadable one', () => {
    const clock = new GatewayClock(() => GATEWAY_NOW_MS + 20_000);
    clock.noteResponse(new Headers({ date: new Date(GATEWAY_NOW_MS).toUTCString() }));
    clock.noteResponse(new Headers());
    clock.noteResponse(new Headers({ date: 'not a date' }));
    assert.equal(clock.offsetMs(), -19_500);
  });
});

describe('the stream list read', () => {
  it("corrects the gateway clock from the stream list response's Date header", async () => {
    const clock = new GatewayClock(() => GATEWAY_NOW_MS - 60_000);
    const response: TimedResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'swarm-feed-index': '0000000000000000', date: new Date(GATEWAY_NOW_MS).toUTCString() }),
      text: '[]',
    };
    const reader = new CatalogFeedReader(
      '1f6e0f8a9b7c3d5e2a4b6c8d0e1f2a3b4c5d6e7f',
      Topic.fromString('gateway-clock-test'),
      (async () => response) as never,
      clock,
    );

    await reader.read('https://gateway.example.com');

    assert.equal(clock.offsetMs(), 60_500);
  });
});
