import { describe, expect, it } from 'vitest';

import { type ReachabilityOptions, unreachableCause } from '../src/components/DomainSelector/reachability';

const PUBLIC_PAGE = 'https://viewer.example.com/';
const NOTHING = { kind: 'unreachable' } as const;

function options(overrides: Partial<ReachabilityOptions>): ReachabilityOptions {
  return { pageUrl: PUBLIC_PAGE, localNetworkRequests: true, permission: async () => 'prompt', ...overrides };
}

function asking(answer: (name: string) => PermissionState | 'unknown') {
  const asked: string[] = [];
  return {
    asked,
    permission: async (name: string) => {
      asked.push(name);
      return answer(name);
    },
  };
}

describe('a node that answered and refused this site', () => {
  it('is a CORS refusal, whatever the browser would say about its network', async () => {
    const { asked, permission } = asking(() => 'denied');
    expect(
      await unreachableCause('http://localhost:1633', { kind: 'refuses-this-site' }, options({ permission })),
    ).toEqual({ kind: 'cors-refused' });
    expect(asked).toEqual([]);
  });
});

describe("the browser's local network permission, for an address where nothing answered", () => {
  it('is named when the browser says this site was refused it', async () => {
    const { asked, permission } = asking(() => 'denied');
    expect(await unreachableCause('http://192.168.1.20:1633', NOTHING, options({ permission }))).toEqual({
      kind: 'local-network-refused',
    });
    expect(asked[0]).toBe('local-network');
  });

  it('is asked under its loopback name for a node on this computer', async () => {
    const { asked, permission } = asking(() => 'denied');
    await unreachableCause('http://localhost:1633', NOTHING, options({ permission }));

    expect(asked[0]).toBe('loopback-network');
  });

  it('falls back to the name Chrome shipped first when the draft names are unknown', async () => {
    const { asked, permission } = asking((name) => (name === 'local-network-access' ? 'denied' : 'unknown'));
    expect(await unreachableCause('http://localhost:1633', NOTHING, options({ permission }))).toEqual({
      kind: 'local-network-refused',
    });
    expect(asked).toEqual(['loopback-network', 'local-network-access']);
  });

  it('may still be the cause while the browser has not been answered, and is offered as one', async () => {
    expect(await unreachableCause('http://localhost:1633', NOTHING, options({}))).toEqual({
      kind: 'unreachable-local',
    });
  });

  it('is not the cause once granted', async () => {
    const { permission } = asking(() => 'granted');
    expect(await unreachableCause('http://localhost:1633', NOTHING, options({ permission }))).toEqual(NOTHING);
  });

  it('is not in play for a node on the internet, on a page on this computer, or in a browser without it', async () => {
    const { asked, permission } = asking(() => 'denied');
    expect(await unreachableCause('https://bee.example.com', NOTHING, options({ permission }))).toEqual(NOTHING);
    expect(
      await unreachableCause(
        'http://localhost:1633',
        NOTHING,
        options({ permission, pageUrl: 'http://localhost:5173/' }),
      ),
    ).toEqual(NOTHING);
    expect(
      await unreachableCause('http://localhost:1633', NOTHING, options({ permission, localNetworkRequests: false })),
    ).toEqual(NOTHING);
    expect(asked).toEqual([]);
  });

  it('is in play from a local network page to this computer, the more private of the two', async () => {
    const { permission } = asking(() => 'denied');
    expect(
      await unreachableCause(
        'http://localhost:1633',
        NOTHING,
        options({ permission, pageUrl: 'http://192.168.1.5:8080/' }),
      ),
    ).toEqual({ kind: 'local-network-refused' });
  });
});
