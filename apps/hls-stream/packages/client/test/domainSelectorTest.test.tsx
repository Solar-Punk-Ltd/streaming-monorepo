// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/** The picker inside the app, as a build with two gateways starts it, opened. */
async function open() {
  vi.stubEnv('VITE_SWARM_PROVIDERS', TWO_GATEWAYS);
  vi.resetModules();
  const app = await import('../src/providers/App');
  const { DomainSelector } = await import('../src/components/DomainSelector/DomainSelector');
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(app.AppContextProvider, { children: createElement(DomainSelector) })));
  await settle();
  click(buttonNamed(/^Bee node/));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(holds: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (holds()) {
      return;
    }
    await settle();
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

  it('tests a gateway on every feature and shows each sentence', async () => {
    await open();
    click(buttonNamed('Test', row('Backup gateway')));
    await waitFor(() => text().includes('The gateway answered in'), 'the test to finish');

    const results = row('Backup gateway').textContent ?? '';
    expect(results).toContain('Connection: passed');
    expect(results).toContain('This gateway answered that the stream list is not there.');
    expect(results).toContain('Not tested: the stream list has no stream to test with.');
    expect(results).not.toContain('Chat');
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
    await waitFor(() => text().includes('The gateway answered in'), 'the test to finish');
    click(buttonNamed('Copy report'));
    await waitFor(() => copied !== null, 'the report to be copied');
    await settle();

    expect(copied).toContain(`Test of Backup gateway (${BACKUP})`);
    expect(copied).toContain('Status, the last minute');
    expect(copied).not.toContain(EVENT);
    expect(text()).toContain('Report copied.');
  });
});
