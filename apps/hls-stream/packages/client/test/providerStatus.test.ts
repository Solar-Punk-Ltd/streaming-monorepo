import { Topic } from '@ethersphere/bee-js';
import { describe, expect, it } from 'vitest';

import { isServingFromFallback, statusRows } from '../src/components/DomainSelector/providerStatus';
import { SwarmClient } from '../src/swarm/client';
import { content, fault, notFound, ScriptedProvider } from './helpers/scriptedProvider';

const OWNER = '1'.repeat(40);
const TOPIC = Topic.fromString('status-test');
const NAMES: Record<string, string> = {
  event: 'Default gateway',
  backup: 'Backup gateway',
};
const nameOf = (id: string) => NAMES[id] ?? id;

function world() {
  const event = new ScriptedProvider('event');
  const backup = new ScriptedProvider('backup');
  let nowMs = 1_000_000;
  const client = new SwarmClient({
    chosen: { id: 'event', provider: event },
    fallback: { id: 'backup', provider: backup },
    pausePolicy: { faultsBeforePause: 2, firstPauseMs: 15_000, longestPauseMs: 15_000 },
    now: () => nowMs,
  });
  return { event, backup, client, now: () => nowMs, advance: (ms: number) => (nowMs += ms) };
}

describe('the status rows', () => {
  it('name every fallback in the order it is asked', () => {
    const client = new SwarmClient({
      chosen: { id: 'own', provider: new ScriptedProvider('own') },
      fallbacks: [
        { id: 'backup', provider: new ScriptedProvider('backup') },
        { id: 'event', provider: new ScriptedProvider('event') },
      ],
    });

    expect(statusRows(client.activity(), client.health(), 0, nameOf)[0].route).toBe(
      'Reads from own. Falls back to Backup gateway, then Default gateway.',
    );
  });

  it('say, per feature, who it reads from, who stands behind, and what answered in the last minute', async () => {
    const { event, backup, client, now } = world();
    event.answer = content();
    await client.reader('player').readFeedEntry(OWNER, TOPIC, 1);
    event.answer = notFound;
    await client.reader('player').readFeedEntry(OWNER, TOPIC, 2);
    event.answer = fault;
    backup.answer = content();
    await client.reader('stream-list').readFeedHead(OWNER, TOPIC);
    await client.reader('stream-list').readFeedHead(OWNER, TOPIC);

    expect(statusRows(client.activity(), client.health(), now(), nameOf)).toEqual([
      {
        feature: 'player',
        label: 'Video',
        route: 'Reads from Default gateway, paused for 15 s after failing. Falls back to Backup gateway.',
        answered: 'In the last minute, Default gateway: 1 served, 1 not there yet.',
      },
      {
        feature: 'stream-list',
        label: 'Stream list',
        route: 'Reads from Default gateway, paused for 15 s after failing. Falls back to Backup gateway.',
        answered:
          'In the last minute, Default gateway: 2 failed. Backup gateway: 2 served. 2 answers came from the fallback.',
      },
      {
        feature: 'previews',
        label: 'Previews and pictures',
        route: 'Reads from Default gateway, paused for 15 s after failing. Falls back to Backup gateway.',
        answered: 'Nothing read in the last minute.',
      },
    ]);
  });

  it('forget what answered more than a minute ago', async () => {
    const { event, client, now, advance } = world();
    event.answer = content();
    await client.reader('player').readFeedEntry(OWNER, TOPIC, 1);
    advance(60_001);

    expect(statusRows(client.activity(), client.health(), now(), nameOf)[0].answered).toBe(
      'Nothing read in the last minute.',
    );
  });

  it('say there is no fallback when the build has none', () => {
    const client = new SwarmClient({ chosen: { id: 'event', provider: new ScriptedProvider('event') } });

    expect(statusRows(client.activity(), client.health(), 0, nameOf)[0].route).toBe(
      'Reads from Default gateway. No fallback.',
    );
  });
});

describe('whether the Bee node button marks the fallback as serving', () => {
  it('does not while the video reads from the gateway in use', async () => {
    const { event, client } = world();
    event.answer = content();
    await client.reader('player').readFeedEntry(OWNER, TOPIC, 1);

    expect(isServingFromFallback(client.activity(), client.health())).toBe(false);
  });

  it('does once the fallback answered a read of the video in the last minute', async () => {
    const { event, backup, client, advance } = world();
    event.answer = fault;
    backup.answer = content();
    await client.reader('player').readFeedEntry(OWNER, TOPIC, 1);

    expect(isServingFromFallback(client.activity(), client.health())).toBe(true);
    event.answer = content();
    advance(61_000);
    await client.reader('player').readFeedEntry(OWNER, TOPIC, 2);
    expect(isServingFromFallback(client.activity(), client.health())).toBe(false);
  });

  it('does while the gateway the video reads from is paused, whatever answered the video', async () => {
    const { event, backup, client } = world();
    event.answer = fault;
    backup.answer = notFound;
    await client.reader('stream-list').readFeedHead(OWNER, TOPIC);
    await client.reader('stream-list').readFeedHead(OWNER, TOPIC);

    expect(isServingFromFallback(client.activity(), client.health())).toBe(true);
  });

  it('does not when the gateway in use has no fallback behind it, paused or not', async () => {
    const event = new ScriptedProvider('event');
    const client = new SwarmClient({
      chosen: { id: 'event', provider: event },
      pausePolicy: { faultsBeforePause: 1 },
    });
    event.answer = fault;
    await client.reader('player').readFeedEntry(OWNER, TOPIC, 1);

    expect(client.health()[0].pausedUntilMs).not.toBeNull();
    expect(isServingFromFallback(client.activity(), client.health())).toBe(false);
  });
});
