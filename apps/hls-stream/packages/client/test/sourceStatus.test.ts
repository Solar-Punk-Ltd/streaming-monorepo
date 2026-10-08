import { describe, expect, it } from 'vitest';

import { checkSourceStatus, sourceStatusWords } from '../src/components/DomainSelector/sourceStatus';
import { SwarmClient } from '../src/swarm/client';
import type { ProbeResult } from '../src/swarm/provider';
import { content, fault, notFound, ScriptedProvider } from './helpers/scriptedProvider';

const CATALOG = { owner: '1'.repeat(40), topic: 'event-streams' };
const GATEWAY = { type: 'gateway' as const, url: 'https://gw.example.com' };
const NODE = { type: 'bee-node' as const, url: 'http://localhost:1633' };

/** A client on one scripted provider whose probe answers `probe`, and a clock each read moves on by 120 ms. */
function world(probe: ProbeResult = { kind: 'ok', elapsedMs: 0 }) {
  const provider = new ScriptedProvider('source');
  provider.probe = async () => probe;
  let nowMs = 0;
  provider.onAsk = () => void (nowMs += 120);
  const client = new SwarmClient({ chosen: { id: 'source', provider } });
  const context = {
    catalog: CATALOG,
    pageProtocol: 'https:',
    localNetworkRequests: false,
    now: () => nowMs,
    client: () => client,
  };
  return { provider, context };
}

describe('the light check of a source', () => {
  it("reads a gateway's first stream list entry by index, never the head a long list makes Bee search for", async () => {
    const { provider, context } = world();
    provider.answer = content();

    expect(await checkSourceStatus(GATEWAY, context)).toEqual({ health: 'ok', elapsedMs: 120 });
    expect(provider.asked).toEqual(['feed-entry']);
  });

  it('takes a gateway answering that the list is not there as answering', async () => {
    const { provider, context } = world();
    provider.answer = notFound;

    expect((await checkSourceStatus(GATEWAY, context)).health).toBe('ok');
  });

  it('fails a gateway that does not answer, and warns about one that asks to be asked less', async () => {
    const { provider, context } = world();
    provider.answer = fault;
    expect(await checkSourceStatus(GATEWAY, context)).toEqual({ health: 'failing', elapsedMs: null });

    provider.answer = { kind: 'rate-limited', retryAfterMs: 1_000 };
    expect(await checkSourceStatus(GATEWAY, context)).toEqual({ health: 'warning', elapsedMs: null, words: 'Busy' });
  });

  it('warns about a gateway that answers with an error, which is there and not serving', async () => {
    const { provider, context } = world();
    provider.answer = { kind: 'unavailable', cause: { kind: 'status', status: 502 } };

    expect(await checkSourceStatus(GATEWAY, context)).toEqual({ health: 'warning', elapsedMs: null, words: 'Errors' });
  });

  it('asks a Bee node the provider probe, and says it is starting while it is not ready', async () => {
    expect(await checkSourceStatus(NODE, world({ kind: 'ok', elapsedMs: 42 }).context)).toEqual({
      health: 'ok',
      elapsedMs: 42,
    });
    expect(await checkSourceStatus(NODE, world({ kind: 'not-ready', reason: { kind: 'starting' } }).context)).toEqual({
      health: 'warning',
      elapsedMs: null,
      words: 'Starting',
    });
    expect((await checkSourceStatus(NODE, world({ kind: 'unreachable' }).context)).health).toBe('failing');
  });

  it('fails a plain http address the browser would block, without asking it', async () => {
    const { provider, context } = world();

    expect((await checkSourceStatus({ type: 'gateway', url: 'http://gw.example.com' }, context)).health).toBe(
      'failing',
    );
    expect(provider.asked).toEqual([]);
  });

  it('is unknown when it was stopped', async () => {
    const { provider, context } = world();
    provider.answer = { kind: 'aborted' };

    expect(await checkSourceStatus(GATEWAY, context)).toEqual({ health: 'unknown', elapsedMs: null });
  });
});

describe('the words beside a status dot', () => {
  it('give the time for a source that answered, and the state for the rest', () => {
    expect(sourceStatusWords({ health: 'ok', elapsedMs: 118 })).toBe('118 ms');
    expect(sourceStatusWords({ health: 'warning', elapsedMs: null, words: 'Busy' })).toBe('Busy');
    expect(sourceStatusWords({ health: 'warning', elapsedMs: null })).toBe('Not ready');
    expect(sourceStatusWords({ health: 'failing', elapsedMs: null })).toBe('Not answering');
    expect(sourceStatusWords({ health: 'unknown', elapsedMs: null })).toBe('Checking');
  });
});
