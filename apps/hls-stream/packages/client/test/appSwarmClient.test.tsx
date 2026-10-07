// @vitest-environment jsdom
import { Topic } from '@ethersphere/bee-js';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { useAppContext as UseAppContext } from '../src/providers/App';
import type { SwarmClient } from '../src/swarm/client';
import { chooseSource, setMode, setPart } from '../src/swarm/routing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REFERENCE = 'ef'.repeat(32);
/** The one Bee URL the test build names, as the dev server's proxy rewrites a local node. */
const BUILD_GATEWAY = '/bee';
const OWN_NODE = 'http://localhost:1633';
const EVENT_GATEWAY = 'https://event.example.com';
const BACKUP_GATEWAY = 'https://backup.example.com';
const STREAM_OWNER = '2'.repeat(40);
const STREAM_TOPIC_HEX = Topic.fromString('a-stream').toString();
/** The stream list's feed the test build names, as `vitest.config.ts` sets it. */
const CATALOG_OWNER = '0x0000000000000000000000000000000000000000';
const CATALOG_TOPIC = 'test-topic';
/** Where the node picker kept a viewer's node before sources existed. */
const LEGACY_STORAGE_KEY = 'swarm-gateway-url';
/** Where the instrumentation handle is published in a build made with `VITE_EXPOSE_PLAYER`. */
const GATEWAY_HANDLE = '__swarmGatewaySwitch';

const TWO_GATEWAYS = JSON.stringify({
  gateways: [
    { id: 'event', kind: 'bee-http', url: EVENT_GATEWAY },
    { id: 'backup', kind: 'bee-http', url: BACKUP_GATEWAY },
  ],
  default: 'event',
  fallback: 'backup',
});

type Context = ReturnType<typeof UseAppContext>;

const realFetch = globalThis.fetch;
let asked: string[];
/** The `Date` every answer carries. */
let serverDate: string;
let root: Root | null = null;
let context: Context | null = null;

/**
 * The app as a build with these providers starts it. The config module reads the build's variables
 * once, at import, so every start imports the app afresh.
 */
async function start(providers?: string) {
  vi.stubEnv('VITE_SWARM_PROVIDERS', providers);
  vi.resetModules();
  const app = await import('../src/providers/App');
  const { manifestFetcher } = await import('../src/components/SwarmHlsPlayer/CustomManifestLoader');
  const { buildSwarmUri } = await import('../src/components/SwarmHlsPlayer/playlist');
  const { gatewayClock } = await import('../src/utils/gatewayClock');
  function Probe() {
    context = app.useAppContext();
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(app.AppContextProvider, { children: createElement(Probe) })));
  await settle();
  return { manifestFetcher, sourceUrl: buildSwarmUri(STREAM_OWNER, 'a-stream'), gatewayClock };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const current = (): Context => context!;

/** Adds the viewer's own node as a source and reads every part from it, as the node picker does. */
async function pickOwnNode(): Promise<string> {
  let id = '';
  act(() => {
    id = current().addSource({ type: 'bee-node', name: 'Desk node', url: OWN_NODE });
  });
  act(() => current().setRouting(chooseSource(current().routing, id)));
  await settle();
  return id;
}

async function pickSource(id: string): Promise<void> {
  act(() => current().setRouting(chooseSource(current().routing, id)));
  await settle();
}

async function readThrough(swarm: SwarmClient): Promise<string> {
  const before = asked.length;
  await swarm.reader('previews').readBytes(REFERENCE);
  return asked.slice(before).join(' ');
}

describe("the app's Swarm client", () => {
  beforeEach(() => {
    asked = [];
    serverDate = 'Wed, 07 Oct 2026 12:00:00 GMT';
    localStorage.clear();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response('', { status: 404, headers: { date: serverDate } });
    }) as typeof fetch;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    context = null;
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  it("is made once at start on the build's one Bee URL when the build names no providers", async () => {
    await start();
    const { swarm } = current();
    await settle();

    expect(current().swarm).toBe(swarm);
    expect(await readThrough(swarm)).toBe(`${BUILD_GATEWAY}/bytes/${REFERENCE}`);
    expect(current().parts.player).toBe('gateway');
    expect(current().streamListSourceId).toBe('gateway');
  });

  it('reads the default gateway and falls back to the fallback when the build names providers', async () => {
    // Before the start, because a provider keeps the fetch it was made with.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      if (String(input).startsWith(EVENT_GATEWAY)) {
        throw new TypeError('Failed to fetch');
      }
      return new Response(new Uint8Array([1]));
    }) as typeof fetch;
    await start(TWO_GATEWAYS);

    expect(current().parts.player).toBe('event');
    expect(await readThrough(current().swarm)).toBe(
      `${EVENT_GATEWAY}/bytes/${REFERENCE} ${BACKUP_GATEWAY}/bytes/${REFERENCE}`,
    );
  });

  it("starts on the viewer's node saved before sources existed, moved into a source", async () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, OWN_NODE);
    await start();

    expect(await readThrough(current().swarm)).toBe(`${OWN_NODE}/bytes/${REFERENCE}`);
    expect(current().sources.map(({ name, offered }) => [name, offered])).toContainEqual(['My Bee node', false]);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("starts on the viewer's saved sources and routing", async () => {
    await start();
    await pickOwnNode();
    act(() => root?.unmount());

    await start();
    expect(await readThrough(current().swarm)).toBe(`${OWN_NODE}/bytes/${REFERENCE}`);
  });

  it('is rebuilt on the node the viewer picks, and back on the default gateway', async () => {
    await start();

    await pickOwnNode();
    expect(await readThrough(current().swarm)).toBe(`${OWN_NODE}/bytes/${REFERENCE}`);

    await pickSource('gateway');
    expect(await readThrough(current().swarm)).toBe(`${BUILD_GATEWAY}/bytes/${REFERENCE}`);
  });

  it('is not rebuilt for a rename, which changes nothing it reads', async () => {
    await start();
    const id = await pickOwnNode();
    const before = current().swarm;

    act(() => current().renameSource(id, 'Laptop'));
    await settle();

    expect(current().swarm).toBe(before);
    expect(current().sources.find((source) => source.id === id)?.name).toBe('Laptop');
  });

  it('reads each part from its own source per part', async () => {
    await start(TWO_GATEWAYS);
    const id = await pickOwnNode();
    act(() => current().setRouting(setPart(setMode(current().routing, 'per-part'), 'previews', 'backup')));
    await settle();

    expect(await readThrough(current().swarm)).toBe(`${BACKUP_GATEWAY}/bytes/${REFERENCE}`);
    expect(current().parts).toEqual({ player: id, 'stream-list': id, previews: 'backup' });
  });

  it('moves every part off a source the viewer removes, onto the default gateway', async () => {
    await start();
    const id = await pickOwnNode();

    act(() => current().removeSource(id));
    await settle();

    expect(await readThrough(current().swarm)).toBe(`${BUILD_GATEWAY}/bytes/${REFERENCE}`);
    expect(current().sources.map((source) => source.id)).not.toContain(id);
  });

  it("asks the fallbacks in the viewer's order", async () => {
    await start(TWO_GATEWAYS);
    expect(current().fallbackOrder).toEqual(['backup', 'event']);
    await pickOwnNode();

    expect(current().swarm.activity()[0].fallbackOrder).toEqual(['backup', 'event']);
  });

  it('lets a measurement harness move every part to an address and read back where it reads', async () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', 'true');
    await start(TWO_GATEWAYS);
    const handle = (globalThis as unknown as Record<string, { current(): string; select(url: string): void }>)[
      GATEWAY_HANDLE
    ];

    act(() => handle.select(`${OWN_NODE}/`));
    await settle();
    expect(handle.current()).toBe(OWN_NODE);
    expect(await readThrough(current().swarm)).toBe(`${OWN_NODE}/bytes/${REFERENCE}`);

    act(() => handle.select(BACKUP_GATEWAY));
    await settle();
    expect(handle.current()).toBe(BACKUP_GATEWAY);
    expect(current().parts.player).toBe('backup');
    expect(current().sources.filter(({ offered }) => !offered)).toHaveLength(1);
  });

  it("reads the stream list through the client's stream-list reader, on the node picked", async () => {
    await start();
    const catalogHead = `${BUILD_GATEWAY}/feeds/${CATALOG_OWNER}/${Topic.fromString(CATALOG_TOPIC).toString()}`;
    expect(asked[0]).toBe(catalogHead);

    const id = await pickOwnNode();
    await act(() => current().fetchAppState());

    expect(
      current()
        .swarm.counts()
        .filter(({ feature }) => feature === 'stream-list'),
    ).toEqual([{ feature: 'stream-list', read: 'feed-head', provider: id, answer: 'not-found', count: 1 }]);
  });

  it("hands the player the client's player reader, at start and on every node picked", async () => {
    const { manifestFetcher, sourceUrl } = await start();
    const before = asked.length;

    await manifestFetcher.fetchSource(sourceUrl).catch(() => {});
    const id = await pickOwnNode();
    await manifestFetcher.fetchSource(sourceUrl).catch(() => {});

    expect(asked.slice(before)).toEqual([
      `${BUILD_GATEWAY}/feeds/${STREAM_OWNER}/${STREAM_TOPIC_HEX}`,
      `${OWN_NODE}/feeds/${STREAM_OWNER}/${STREAM_TOPIC_HEX}`,
    ]);
    expect(
      current()
        .swarm.counts()
        .filter(({ feature }) => feature === 'player'),
    ).toEqual([{ feature: 'player', read: 'feed-head', provider: id, answer: 'not-found', count: 1 }]);
  });

  it("keeps the shared gateway clock from the player's answers' server time", async () => {
    const { gatewayClock } = await start();
    const before = gatewayClock.offsetMs();

    serverDate = 'Thu, 01 Jan 2099 00:00:00 GMT';
    await current().swarm.reader('player').readBytes(REFERENCE);

    expect(gatewayClock.offsetMs()).toBeGreaterThan(before);
  });
});
