// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SOURCE_CHECK_INTERVAL_MS } from '../src/components/DomainSelector/sourceStatus';
import { useSourceStatuses } from '../src/components/DomainSelector/useSourceStatuses';
import type { Source } from '../src/swarm/sources';

import { beeNotFound } from './helpers/fakeBeeGateway';

const PUBLIC_GATEWAY: Source = {
  id: 'added-1',
  type: 'gateway',
  name: 'Public gateway',
  url: 'https://gw.example.com',
  offered: false,
};
const CATALOG = { owner: '1'.repeat(40), topic: 'event-streams' };

/** The front door of a public gateway, which refuses `/soc` with plain text before Bee sees it. */
const refusedRoute = () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });

function Checks({ isOpen }: { readonly isOpen: boolean }) {
  useSourceStatuses([PUBLIC_GATEWAY], isOpen, CATALOG);
  return null;
}

let asked: string[];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      return new URL(url).pathname.startsWith('/soc/') ? refusedRoute() : beeNotFound();
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const socAsks = () => asked.filter((url) => new URL(url).pathname.startsWith('/soc/')).length;

async function checksRun(count: number): Promise<void> {
  for (let check = 1; check < count; check++) {
    await act(() => vi.advanceTimersByTimeAsync(SOURCE_CHECK_INTERVAL_MS));
  }
  await act(() => vi.advanceTimersByTimeAsync(0));
}

describe("the node picker's status checks of a gateway that refuses /soc", () => {
  it('ask /soc once while the picker stays open, and read the entry by its chunk address after that', async () => {
    act(() => root.render(createElement(Checks, { isOpen: true })));
    await checksRun(3);

    expect(asked.filter((url) => new URL(url).pathname.startsWith('/chunks/'))).toHaveLength(3);
    expect(socAsks()).toBe(1);
  });
});
