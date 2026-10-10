// @vitest-environment jsdom
import { Topic } from '@ethersphere/bee-js';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTED_BY_CONTENT,
  NODE_NOT_READY,
  UNREACHABLE_SENTENCES,
} from '../src/components/DomainSelector/checkSentences';
import type { SwarmClient } from '../src/swarm/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EVENT = 'https://event.example.com';
const BACKUP = 'https://backup.example.com';

const THIRD = 'https://third.example.com';
const ADDED = 'https://gw.example.com';

const TWO_GATEWAYS = JSON.stringify({
  gateways: [
    { id: 'event', kind: 'bee-http', label: 'Event gateway', url: EVENT },
    { id: 'backup', kind: 'bee-http', label: 'Backup gateway', url: BACKUP },
  ],
  default: 'event',
});

const THREE_GATEWAYS = JSON.stringify({
  gateways: [
    { id: 'event', kind: 'bee-http', label: 'Event gateway', url: EVENT },
    { id: 'backup', kind: 'bee-http', label: 'Backup gateway', url: BACKUP },
    { id: 'third', kind: 'bee-http', label: 'Third gateway', url: THIRD },
  ],
  default: 'event',
  fallback: ['backup', 'third'],
});

const realFetch = globalThis.fetch;
let root: Root | null = null;
let copied: string | null = null;
let swarm: SwarmClient | null = null;
let parts: Record<string, string> | null = null;

/** The picker inside the app, as a build with these gateways starts it, opened. */
async function open(providers = TWO_GATEWAYS) {
  vi.stubEnv('VITE_SWARM_PROVIDERS', providers);
  vi.resetModules();
  const app = await import('../src/providers/App');
  const { DomainSelector } = await import('../src/components/DomainSelector/DomainSelector');
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  function Probe() {
    swarm = app.useAppContext().swarm;
    parts = { ...app.useAppContext().parts };
    return null;
  }
  act(() =>
    root!.render(
      createElement(app.AppContextProvider, {
        children: [createElement(DomainSelector, { key: 'picker' }), createElement(Probe, { key: 'probe' })],
      }),
    ),
  );
  await settle();
  click(buttonNamed(/^Sources/));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(holds: () => boolean, what: string, pauseMs = 0): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (holds()) {
      return;
    }
    if (pauseMs === 0) {
      await settle();
    } else {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      });
    }
  }
  throw new Error(`timed out waiting for ${what}`);
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

function buttonNamed(name: RegExp | string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((candidate) => {
    const label = candidate.textContent?.trim() ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!found) {
    throw new Error(`no ${String(name)} button`);
  }
  return found;
}

/** The list item of one source. */
function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[data-source-row]')].find(
    (item) => item.querySelector('.gateway-tools-name')?.textContent === name,
  );
  if (!found) {
    throw new Error(`no source row for ${name}`);
  }
  return found;
}

const text = () => document.body.textContent ?? '';

function labelled<T extends Element>(label: string): T {
  const found = document.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) {
    throw new Error(`nothing labelled ${label}`);
  }
  return found;
}

/** Types into a field as a viewer does, through the setter React listens behind. */
function typeInto(label: string, value: string): void {
  const input = labelled<HTMLInputElement>(label);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function typeAddress(value: string): void {
  typeInto('Address', value);
}

function pick(label: string, value: string): void {
  const select = labelled<HTMLSelectElement>(label);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Adds a Bee node of the viewer's own through the form, as a viewer does. */
function addBeeNode(name: string, address: string): void {
  pick('Type', 'bee-node');
  typeInto('Name', name);
  typeAddress(address);
  click(buttonNamed('Check and add'));
}

beforeEach(() => {
  localStorage.clear();
  copied = null;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => void (copied = value) },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return Response.json({ status: 'ok' });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe("the node picker's tools", () => {
  it('lists every source the build offers, the one in use marked', async () => {
    await open();

    expect(row('Event gateway').textContent).toContain('in use');
    expect(row('Backup gateway').textContent).not.toContain('in use');
  });

  it("names every row's Test button with that row's source, for a screen reader", async () => {
    await open();

    const named = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(named('Test Backup gateway')).toBe(buttonNamed('Test', row('Backup gateway')));
    expect(named('Test Event gateway')).toBe(buttonNamed('Test', row('Event gateway')));
  });

  it('tests a gateway on every feature and shows each sentence', async () => {
    await open();
    click(buttonNamed('Test', row('Backup gateway')));
    await waitFor(() => text().includes(CONNECTED_BY_CONTENT), 'the test to finish');

    const results = row('Backup gateway').textContent ?? '';
    expect(results).toContain('Connection: passed');
    expect(results).toContain('This gateway answered that the stream list is not there.');
    expect(results).toContain('Not tested: the stream list has no stream to test with.');
    expect(results).not.toContain('Chat');
  });

  it("asks a node of the viewer's own for its health, and a gateway the build offers for none", async () => {
    const asked: string[] = [];
    const answer = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(String(input));
      return answer(input, init);
    }) as typeof fetch;
    await open();
    click(buttonNamed('Test', row('Backup gateway')));
    await waitFor(() => row('Backup gateway').textContent?.includes(CONNECTED_BY_CONTENT) ?? false, 'the test');
    expect(asked.filter((url) => url.endsWith('/health'))).toEqual([]);

    addBeeNode('Desk node', 'http://localhost:1633');
    await waitFor(() => document.querySelector('[data-source-row="added-1"]') !== null, 'the node to be added');
    asked.length = 0;
    click(buttonNamed('Test', row('Desk node')));
    await waitFor(() => row('Desk node').textContent?.includes('The gateway answered in') ?? false, 'the test');
    // The row's status dot is checked again with the Test, by the same probe, so the health may be asked twice.
    expect(new Set(asked.filter((url) => url.endsWith('/health')))).toEqual(new Set(['http://localhost:1633/health']));
    expect(asked).toContain('http://localhost:1633/readiness');
  });

  it("shows the exact cors-allowed-origins lines for this page's origin when a node answers and refuses this site", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.mode === 'no-cors') {
        return new Response(null);
      }
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await open();
    addBeeNode('', 'localhost:1633');
    await waitFor(() => text().includes(UNREACHABLE_SENTENCES['cors-refused']), 'the CORS sentence');

    const picker = document.querySelector('.gateway-modal')?.textContent ?? '';
    expect(picker).toContain(`cors-allowed-origins: ["${window.location.origin}"]`);
    expect(picker).toContain(`BEE_CORS_ALLOWED_ORIGINS=${window.location.origin}`);
    expect(picker).toContain('Swarm Desktop');
    expect(localStorage.length).toBe(0);
  });

  it("shows the CORS lines under a Test of the viewer's own node that answers and refuses this site", async () => {
    localStorage.setItem('swarm-gateway-url', 'http://localhost:1633');
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.mode === 'no-cors') {
        return new Response(null);
      }
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await open();
    click(buttonNamed('Test', row('My Bee node')));
    await waitFor(
      () => row('My Bee node').textContent?.includes(UNREACHABLE_SENTENCES['cors-refused']) ?? false,
      'the test',
    );

    expect(row('My Bee node').textContent).toContain(`BEE_CORS_ALLOWED_ORIGINS=${window.location.origin}`);
  });

  it("says a node of the viewer's own is still starting rather than adding it", async () => {
    const answer = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/readiness')
        ? Promise.resolve(Response.json({ status: 'notReady' }, { status: 400 }))
        : answer(input, init)) as typeof fetch;
    await open();
    addBeeNode('Desk node', 'http://localhost:1633');
    await waitFor(() => text().includes(NODE_NOT_READY.starting), 'the not ready sentence');

    expect(document.querySelector('[data-source-row="added-1"]')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('adds a gateway at an https address once its Test connects, and reads from it at once', async () => {
    await open();
    pick('Type', 'gateway');
    typeInto('Name', 'My gateway');
    typeAddress('gw.example.com');
    click(buttonNamed('Check and add'));
    await waitFor(() => document.querySelector('[data-source-row="added-1"]') !== null, 'the gateway to be added');

    expect(row('My gateway').textContent).toContain('gw.example.com, in use');
    expect(row('My gateway').textContent).toContain('Connection: passed');
    expect(parts).toEqual({ player: 'added-1', 'stream-list': 'added-1', previews: 'added-1' });
    expect(JSON.parse(localStorage.getItem('swarm-sources') ?? '[]')).toEqual([
      { id: 'added-1', type: 'gateway', name: 'My gateway', url: ADDED },
    ]);
  });

  it('refuses a gateway whose connection fails, with its sentence', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith(ADDED)) {
        throw new TypeError('Failed to fetch');
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;
    await open();
    pick('Type', 'gateway');
    typeAddress(ADDED);
    click(buttonNamed('Check and add'));
    const said = () => labelled('Add a source').querySelector('[role="status"]')?.textContent ?? '';
    await waitFor(() => said() !== '' && !said().endsWith('...'), 'the check to end');

    expect(said()).toContain('Could not reach');
    expect(document.querySelector('[data-source-row="added-1"]')).toBeNull();
    expect(localStorage.getItem('swarm-sources')).toBeNull();
  });

  it('renames and removes a source the viewer added, and moves the parts it fed back to the default', async () => {
    await open();
    addBeeNode('Desk node', 'http://localhost:1633');
    await waitFor(() => document.querySelector('[data-source-row="added-1"]') !== null, 'the node to be added');
    expect(row('Event gateway').querySelector('button[aria-label^="Rename"]')).toBeNull();
    expect(row('Event gateway').querySelector('button[aria-label^="Remove"]')).toBeNull();

    click(buttonNamed('Rename', row('Desk node')));
    typeInto('New name for Desk node', 'Laptop');
    act(() => labelled<HTMLInputElement>('New name for Desk node').form?.requestSubmit());
    await settle();
    expect(row('Laptop').textContent).toContain('in use');

    click(buttonNamed('Remove', row('Laptop')));
    await settle();
    expect(document.querySelector('[data-source-row="added-1"]')).toBeNull();
    expect(row('Event gateway').textContent).toContain('in use');
    expect(parts?.player).toBe('event');
  });

  it('reads each part from its own source per part, video and stream list linked until unlinked', async () => {
    await open();
    click(labelled<HTMLInputElement>('Per part'));
    pick('Previews and pictures', 'backup');
    expect(parts).toEqual({ player: 'event', 'stream-list': 'event', previews: 'backup' });

    pick('Stream list', 'backup');
    expect(parts).toEqual({ player: 'backup', 'stream-list': 'backup', previews: 'backup' });

    click(labelled<HTMLInputElement>('Link video and stream list'));
    expect(text()).toContain('Live timing may slip while video and stream list differ');
    pick('Video', 'event');
    expect(parts).toEqual({ player: 'event', 'stream-list': 'backup', previews: 'backup' });
  });

  it("shows the fallback order and keeps the viewer's own, the default gateway always last", async () => {
    await open(THREE_GATEWAYS);
    expect(labelled('Fallback').textContent).toContain('Backup gateway, then Third gateway, then Event gateway');
    expect(labelled('Fallback').querySelector('button[aria-label="Move Event gateway up"]')).toBeNull();

    click(labelled<HTMLButtonElement>('Move Backup gateway down'));

    expect(labelled('Fallback').textContent).toContain('Third gateway, then Backup gateway, then Event gateway');
    expect(JSON.parse(localStorage.getItem('swarm-fallback-order') ?? '[]')).toEqual(['third', 'backup', 'event']);
    expect(swarm?.activity()[0].fallbackOrder).toEqual(['third', 'backup']);
  });

  it('puts a status dot on every source, with the time a gateway took to answer', async () => {
    await open();
    await waitFor(
      () => row('Backup gateway').querySelector('[data-health="ok"]') !== null,
      'the light check of the backup',
    );

    expect(row('Backup gateway').querySelector('.source-status')?.textContent).toMatch(/^\d+ ms$/);
  });

  it('forgets a Test the viewer stopped by closing the picker, so it can be run again', async () => {
    // Every read but the health check waits until it is stopped, so the Test is still running at close.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/health')) {
        return Response.json({ status: 'ok' });
      }
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')));
      });
    }) as typeof fetch;
    await open();
    click(buttonNamed('Test', row('Backup gateway')));
    expect(row('Backup gateway').textContent).toContain('Testing...');

    click(buttonNamed('Close'));
    await settle();
    click(buttonNamed(/^Sources/));

    expect(row('Backup gateway').textContent).not.toContain('Testing');
    expect(buttonNamed('Test', row('Backup gateway')).disabled).toBe(false);
  });

  it('marks the Sources button while the fallback serves the video, with the picker closed', async () => {
    const VIDEO_OWNER = 'a'.repeat(40);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return Response.json({ status: 'ok' });
      }
      return new Response('', { status: url.startsWith(BACKUP) && url.includes(VIDEO_OWNER) ? 502 : 404 });
    }) as typeof fetch;
    await open();
    click(labelled<HTMLInputElement>('Use Backup gateway'));
    click(buttonNamed('Close'));
    await settle();
    expect(buttonNamed(/^Sources/).textContent).toContain('Backup gateway');
    expect(buttonNamed(/^Sources/).textContent).not.toContain('Using fallback');

    await swarm?.reader('player').readFeedEntry(VIDEO_OWNER, Topic.fromString('a-rung'), 0);

    await waitFor(() => buttonNamed(/^Sources/).textContent?.includes('Using fallback') ?? false, 'the marker', 20);
  });

  it('shows who answered each feature in the last minute', async () => {
    await open();

    const status = document.querySelector('[aria-label="Status"]')?.textContent ?? '';
    expect(status).toContain('Stream list');
    expect(status).toContain('Reads from Event gateway. No fallback.');
    expect(status).toContain('In the last minute, Event gateway: 1 not there yet.');
  });

  it('copies a report of the last test and the status, with no address but the tested one', async () => {
    await open();
    click(buttonNamed('Test', row('Backup gateway')));
    await waitFor(() => text().includes(CONNECTED_BY_CONTENT), 'the test to finish');
    click(buttonNamed('Copy report'));
    await waitFor(() => copied !== null, 'the report to be copied');
    await settle();

    expect(copied).toContain(`Test of Backup gateway (${BACKUP})`);
    expect(copied).toContain('Status, the last minute');
    expect(copied).not.toContain(EVENT);
    expect(text()).toContain('Report copied.');
  });
});
