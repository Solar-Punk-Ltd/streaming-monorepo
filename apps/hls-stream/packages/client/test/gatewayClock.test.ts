import { Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { CatalogFeedReader } from '../src/utils/catalogFeed.js';
import { GatewayClock } from '../src/utils/gatewayClock.js';
import { SwarmClient } from '../src/swarm/client.js';
import { BeeHttpProvider } from '../src/swarm/providers/bee-http/beeHttpProvider.js';

const GATEWAY_NOW_MS = Date.UTC(2026, 9, 7, 12, 0, 30);

describe('the gateway clock', () => {
  it('has no correction before any Date header has been seen', () => {
    const clock = new GatewayClock(() => GATEWAY_NOW_MS - 90_000);
    assert.equal(clock.offsetMs(), 0);
  });

  it('takes the offset of a viewer clock that runs behind from the Date header', () => {
    let viewerMs = GATEWAY_NOW_MS - 90_000;
    const clock = new GatewayClock(() => viewerMs);
    clock.noteServerTime(Date.parse(new Date(GATEWAY_NOW_MS).toUTCString()));

    // The header is whole seconds, so the gateway's instant is taken as the middle of that second.
    assert.equal(clock.offsetMs(), 90_500);
    viewerMs += 4_000;
    assert.equal(clock.offsetMs(), 90_500, 'the offset stays put as the viewer clock moves');
  });

  it('takes the same offset from a server time already read out of the header', () => {
    const clock = new GatewayClock(() => GATEWAY_NOW_MS - 90_000);
    clock.noteServerTime(GATEWAY_NOW_MS);
    assert.equal(clock.offsetMs(), 90_500);
    clock.noteServerTime(Number.NaN);
    assert.equal(clock.offsetMs(), 90_500, 'an unreadable time leaves the offset as it was');
  });

  it('keeps the last offset when a response carries no Date or an unreadable one', () => {
    const clock = new GatewayClock(() => GATEWAY_NOW_MS + 20_000);
    clock.noteServerTime(Date.parse(new Date(GATEWAY_NOW_MS).toUTCString()));
    clock.noteServerTime(Number.NaN);
    clock.noteServerTime(Date.parse('not a date'));
    assert.equal(clock.offsetMs(), -19_500);
  });
});

describe('the stream list read', () => {
  it("corrects the gateway clock from the stream list answer's Date header, through the Swarm client", async () => {
    const clock = new GatewayClock(() => GATEWAY_NOW_MS - 60_000);
    const fetcher = (async () =>
      new Response('[]', {
        headers: { 'swarm-feed-index': '0000000000000000', date: new Date(GATEWAY_NOW_MS).toUTCString() },
      })) as typeof fetch;
    const provider = new BeeHttpProvider({ baseUrl: 'https://gateway.example.com', fetcher });
    const client = new SwarmClient({ chosen: { id: 'gateway', provider }, clock });
    const reader = new CatalogFeedReader(
      '1f6e0f8a9b7c3d5e2a4b6c8d0e1f2a3b4c5d6e7f',
      Topic.fromString('gateway-clock-test'),
    );

    await reader.read(client.reader('stream-list'));

    assert.equal(clock.offsetMs(), 60_500);
  });
});
