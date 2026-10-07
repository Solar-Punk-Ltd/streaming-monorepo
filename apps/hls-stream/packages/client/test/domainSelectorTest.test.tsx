// @vitest-environment jsdom
import { Topic } from '@ethersphere/bee-js';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECTED_BY_CONTENT, NODE_NOT_READY } from '../src/components/DomainSelector/checkSentences';
import type { SwarmClient } from '../src/swarm/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EVENT = 'https://event.example.com';
const BACKUP = 'https://backup.example.com';

const TWO_GATEWAYS = JSON.stringify({
  gateways: [
    { id: 'event', kind: 'bee-http', label: 'Event gateway', url: EVENT },
    { id: 'backup', kind: 'bee-http', label: 'Backup gateway', url: BACKUP },
  ],
  default: 'event',
});

const realFetch = globalThis.fetch;
let root: Root | null = null;
let copied: string | null = null;
let swarm: SwarmClient | null = null;

/** The picker inside the app, as a build with two gateways starts it, opened. */
async function open() {
  vi.stubEnv('VITE_SWARM_PROVIDERS', TWO_GATEWAYS);
  vi.resetModules();
  const app = await import('../src/providers/App');
  const { DomainSelector } = await import('../src/components/DomainSelector/DomainSelector');
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  function Probe() {
    swarm = app.useAppContext().swarm;
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
  click(buttonNamed(/^Bee node/));
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

/** The list item of one gateway among the ones the picker can test. */
function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[data-gateway-row]')].find((item) =>
    item.textContent?.includes(name),
  );
  if (!found) {
    throw new Error(`no gateway row for ${name}`);
  }
  return found;
}

const text = () => document.body.textContent ?? '';

/** Types into the picker's address field as a viewer does, through the setter React listens behind. */
function typeAddress(value: string): void {
  const input = document.querySelector<HTMLInputElement>('.gateway-modal-input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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
  it('lists every gateway the build offers, the one in use and the one behind it', async () => {
    await open();

    expect(row('Event gateway').textContent).toContain('in use');
    expect(row('Backup gateway').textContent).not.toContain('in use');
  });

  it("names every row's Test button with that row's gateway, for a screen reader", async () => {
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

    typeAddress('http://localhost:1633');
    click(buttonNamed('Check and use'));
    await waitFor(() => document.querySelector('.gateway-modal') === null, 'the picker to close on the own node');
    click(buttonNamed(/^Bee node/));
    asked.length = 0;
    click(buttonNamed('Test', row('Your own node')));
    await waitFor(() => row('Your own node').textContent?.includes('The gateway answered in') ?? false, 'the test');
    expect(asked.filter((url) => url.endsWith('/health'))).toEqual(['http://localhost:1633/health']);
    expect(asked).toContain('http://localhost:1633/readiness');
  });

  it("says a node of the viewer's own is still starting rather than switching to it", async () => {
    const answer = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/readiness')
        ? Promise.resolve(Response.json({ status: 'notReady' }, { status: 400 }))
        : answer(input, init)) as typeof fetch;
    await open();
    typeAddress('http://localhost:1633');
    click(buttonNamed('Check and use'));
    await waitFor(() => text().includes(NODE_NOT_READY.starting), 'the not ready sentence');

    expect(document.querySelector('.gateway-modal')).not.toBeNull();
    expect(localStorage.length).toBe(0);
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

    click(buttonNamed('Cancel'));
    await settle();
    click(buttonNamed(/^Bee node/));

    expect(row('Backup gateway').textContent).not.toContain('Testing');
    expect(buttonNamed('Test', row('Backup gateway')).disabled).toBe(false);
  });

  it('marks the Bee node button while the fallback serves the video, with the picker closed', async () => {
    const VIDEO_OWNER = 'a'.repeat(40);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return Response.json({ status: 'ok' });
      }
      return new Response('', { status: url.startsWith(BACKUP) && url.includes(VIDEO_OWNER) ? 502 : 404 });
    }) as typeof fetch;
    await open();
    const input = document.querySelector<HTMLInputElement>('.gateway-modal-input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, BACKUP);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(buttonNamed('Check and use'));
    await waitFor(() => document.querySelector('.gateway-modal') === null, 'the picker to close on the backup');
    expect(buttonNamed(/^Bee node/).textContent).not.toContain('Using fallback');

    await swarm?.reader('player').readFeedEntry(VIDEO_OWNER, Topic.fromString('a-rung'), 0);

    await waitFor(() => buttonNamed(/^Bee node/).textContent?.includes('Using fallback') ?? false, 'the marker', 20);
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
