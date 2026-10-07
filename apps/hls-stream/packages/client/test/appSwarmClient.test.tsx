// @vitest-environment jsdom
import { Topic } from '@ethersphere/bee-js';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { useAppContext as UseAppContext } from '../src/providers/App';
import type { SwarmClient } from '../src/swarm/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REFERENCE = 'ef'.repeat(32);
/** The one Bee URL the test build names, as the dev server's proxy rewrites a local node. */
const BUILD_GATEWAY = '/bee';
const OWN_NODE = 'http://localhost:1633';
const EVENT_GATEWAY = 'https://event.example.com';
const BACKUP_GATEWAY = 'https://backup.example.com';
const STREAM_OWNER = '2'.repeat(40);
const STREAM_TOPIC_HEX = Topic.fromString('a-stream').toString();
/** Where a viewer's chosen gateway survives a reload, as the provider keeps it. */
const GATEWAY_STORAGE_KEY = 'swarm-gateway-url';

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
    expect(current().gatewayUrl).toBe(BUILD_GATEWAY);
    expect(current().defaultGatewayUrl).toBe(BUILD_GATEWAY);
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

    expect(current().defaultGatewayUrl).toBe(EVENT_GATEWAY);
    expect(await readThrough(current().swarm)).toBe(
      `${EVENT_GATEWAY}/bytes/${REFERENCE} ${BACKUP_GATEWAY}/bytes/${REFERENCE}`,
    );
  });

  it("starts on the viewer's saved choice", async () => {
    localStorage.setItem(GATEWAY_STORAGE_KEY, OWN_NODE);
    await start();

    expect(await readThrough(current().swarm)).toBe(`${OWN_NODE}/bytes/${REFERENCE}`);
  });

  it('is rebuilt on the node the viewer picks, and back on the default gateway', async () => {
    await start();

    act(() => current().setGatewayUrl(OWN_NODE));
    await settle();
    expect(await readThrough(current().swarm)).toBe(`${OWN_NODE}/bytes/${REFERENCE}`);

    act(() => current().setGatewayUrl(current().defaultGatewayUrl));
    await settle();
    expect(await readThrough(current().swarm)).toBe(`${BUILD_GATEWAY}/bytes/${REFERENCE}`);
  });

  it("hands the player the client's player reader, at start and on every node picked", async () => {
    const { manifestFetcher, sourceUrl } = await start();
    const before = asked.length;

    await manifestFetcher.fetchSource(sourceUrl).catch(() => {});
    act(() => current().setGatewayUrl(OWN_NODE));
    await settle();
    await manifestFetcher.fetchSource(sourceUrl).catch(() => {});

    expect(asked.slice(before)).toEqual([
      `${BUILD_GATEWAY}/feeds/${STREAM_OWNER}/${STREAM_TOPIC_HEX}`,
      `${OWN_NODE}/feeds/${STREAM_OWNER}/${STREAM_TOPIC_HEX}`,
    ]);
    expect(
      current()
        .swarm.counts()
        .filter(({ feature }) => feature === 'player'),
    ).toEqual([{ feature: 'player', read: 'feed-head', provider: 'own-node', answer: 'not-found', count: 1 }]);
  });

  it("keeps the shared gateway clock from every answer's server time", async () => {
    const { gatewayClock } = await start();
    const before = gatewayClock.offsetMs();

    serverDate = 'Thu, 01 Jan 2099 00:00:00 GMT';
    await current().swarm.reader('previews').readBytes(REFERENCE);

    expect(gatewayClock.offsetMs()).toBeGreaterThan(before);
  });
});
