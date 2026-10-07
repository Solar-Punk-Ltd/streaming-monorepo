import { describe, expect, it } from 'vitest';

import { createSwarmClient } from '../../src/swarm/createSwarmClient';
import { PROVIDER_KINDS } from '../../src/swarm/providerKinds';
import { BeeHttpProvider } from '../../src/swarm/providers/bee-http/beeHttpProvider';
import { PROVIDER_REGISTRY } from '../../src/swarm/registry';
import {
  choiceForAddress,
  defaultGateway,
  OWN_GATEWAY_ID,
  parseProvidersSetting,
  SINGLE_GATEWAY_ID,
  swarmSettingsFrom,
} from '../../src/swarm/settings';

const REFERENCE = 'ef'.repeat(32);

const PRIMARY = 'https://primary.example.com';
const BACKUP = 'https://backup.example.com';

const EVENT = { id: 'event', kind: 'bee-http', label: 'Event gateway', url: '/bee' };
const SPARE = { id: 'spare', kind: 'bee-http', url: 'https://spare.example.com' };
const PROVIDERS = { gateways: [EVENT, SPARE], default: 'event', fallback: 'spare', kinds: ['bee-http'] };

const providers = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...PROVIDERS, ...overrides });

function problemOf(raw: string): string {
  try {
    parseProvidersSetting(raw);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected ${raw} to be refused`);
}

const TWO_GATEWAYS = swarmSettingsFrom({
  beeUrl: '/bee',
  providers: parseProvidersSetting(
    JSON.stringify({
      gateways: [
        { id: 'primary', kind: 'bee-http', label: 'Event gateway', url: PRIMARY },
        { id: 'backup', kind: 'bee-http', url: BACKUP },
      ],
      default: 'primary',
      fallback: 'backup',
    }),
  ),
});

/** Every read of the primary fails and every read of the backup is served, and both are logged. */
function primaryDownFetch(asked: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url.startsWith(PRIMARY)) {
      throw new TypeError('Failed to fetch');
    }
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
}

describe('the providers setting', () => {
  it('accepts the gateways offered, the default, the fallback and the kinds offered', () => {
    expect(parseProvidersSetting(providers())).toEqual(PROVIDERS);
  });

  it('accepts no fallback and no list of kinds', () => {
    const { fallback: _fallback, kinds: _kinds, ...bare } = PROVIDERS;

    expect(parseProvidersSetting(JSON.stringify(bare))).toEqual(bare);
  });

  it('refuses a setting that is not JSON, or not an object', () => {
    expect(problemOf('gateways: /bee')).toContain('is not JSON');
    expect(problemOf('["/bee"]')).toContain('must be an object');
  });

  it('refuses a default or a fallback that names no gateway offered', () => {
    expect(problemOf(providers({ default: 'elsewhere' }))).toContain('default');
    expect(problemOf(providers({ fallback: 'elsewhere' }))).toContain('fallback');
  });

  it('refuses a fallback that is the default', () => {
    expect(problemOf(providers({ fallback: 'event' }))).toContain('fallback');
  });

  it('refuses two gateways under one id', () => {
    expect(problemOf(providers({ gateways: [EVENT, { ...SPARE, id: 'event' }] }))).toContain('gateways.1.id');
  });

  it('refuses no gateways at all', () => {
    expect(problemOf(providers({ gateways: [] }))).toContain('gateways');
  });

  it('refuses a kind this build does not carry, in a gateway and in the kinds offered', () => {
    expect(problemOf(providers({ gateways: [{ ...EVENT, kind: 'ipfs' }], fallback: undefined }))).toContain(
      'gateways.0.kind',
    );
    expect(problemOf(providers({ kinds: ['ipfs'] }))).toContain('kinds');
  });

  it("refuses a gateway's address that is neither a path on this site nor http, placeholder included", () => {
    for (const url of ['bee', '//gateway.example.com', '<the event gateway>']) {
      expect(problemOf(providers({ gateways: [{ ...EVENT, url }], fallback: undefined }))).toContain('gateways.0.url');
    }
  });
});

describe('the Swarm settings', () => {
  it('make a build that names only its Bee URL one Bee gateway, the default, with no fallback', () => {
    expect(swarmSettingsFrom({ beeUrl: '/bee', providers: null })).toEqual({
      gateways: [{ id: SINGLE_GATEWAY_ID, kind: 'bee-http', url: '/bee' }],
      defaultId: SINGLE_GATEWAY_ID,
      fallbackId: null,
      kinds: [...PROVIDER_KINDS],
    });
  });

  it('take the gateways, the default, the fallback and the kinds from the providers setting', () => {
    expect(TWO_GATEWAYS).toEqual({
      gateways: [
        { id: 'primary', kind: 'bee-http', label: 'Event gateway', url: PRIMARY },
        { id: 'backup', kind: 'bee-http', url: BACKUP },
      ],
      defaultId: 'primary',
      fallbackId: 'backup',
      kinds: [...PROVIDER_KINDS],
    });
  });
});

describe("the viewer's choice of gateway", () => {
  it('is the default gateway until the viewer picks another', () => {
    expect(defaultGateway(TWO_GATEWAYS)).toEqual({
      id: 'primary',
      kind: 'bee-http',
      label: 'Event gateway',
      url: PRIMARY,
    });
  });

  it('names an offered gateway by its address, a trailing slash either side', () => {
    expect(choiceForAddress(TWO_GATEWAYS, `${BACKUP}/`)).toEqual({ id: 'backup', kind: 'bee-http', url: BACKUP });
  });

  it("is the viewer's own Bee node for an address the settings do not offer", () => {
    expect(choiceForAddress(TWO_GATEWAYS, 'http://localhost:1633')).toEqual({
      id: OWN_GATEWAY_ID,
      kind: 'bee-http',
      url: 'http://localhost:1633',
    });
  });
});

describe('the registry of provider kinds', () => {
  it('has a label and a maker for every kind a setting may name', () => {
    expect(Object.keys(PROVIDER_REGISTRY).sort()).toEqual([...PROVIDER_KINDS].sort());
    for (const kind of PROVIDER_KINDS) {
      expect(PROVIDER_REGISTRY[kind].label).not.toBe('');
    }
  });

  it('makes a Bee HTTP provider for a bee-http gateway', () => {
    const provider = PROVIDER_REGISTRY['bee-http'].create({ id: 'x', kind: 'bee-http', url: '/bee' }, {});

    expect(provider).toBeInstanceOf(BeeHttpProvider);
  });
});

describe('making the client from the settings', () => {
  it('reads from the default gateway, and from the fallback when the default fails', async () => {
    const asked: string[] = [];
    const client = createSwarmClient(TWO_GATEWAYS, { environment: { fetcher: primaryDownFetch(asked) } });

    const answer = await client.reader('player').readBytes(REFERENCE);

    expect(answer.kind).toBe('content');
    expect(asked).toEqual([`${PRIMARY}/bytes/${REFERENCE}`, `${BACKUP}/bytes/${REFERENCE}`]);
    expect(client.health().map(({ id }) => id)).toEqual(['primary', 'backup']);
  });

  it("reads from the viewer's choice among the gateways offered", async () => {
    const asked: string[] = [];
    const client = createSwarmClient(TWO_GATEWAYS, {
      choice: 'backup',
      environment: { fetcher: primaryDownFetch(asked) },
    });

    await client.reader('player').readBytes(REFERENCE);

    expect(asked).toEqual([`${BACKUP}/bytes/${REFERENCE}`]);
    expect(client.health().map(({ id }) => id)).toEqual(['backup']);
  });

  it('reads from the default when the choice names a gateway no longer offered', async () => {
    const client = createSwarmClient(TWO_GATEWAYS, { choice: 'gone' });

    expect(client.health().map(({ id }) => id)).toEqual(['primary', 'backup']);
  });

  it("reads a feature from the gateway its route names, every other feature from the viewer's choice", async () => {
    const asked: string[] = [];
    const previews = { id: 'previews', kind: 'bee-http' as const, url: 'https://previews.example.com' };
    const client = createSwarmClient(TWO_GATEWAYS, {
      choice: 'backup',
      routes: { previews },
      environment: { fetcher: primaryDownFetch(asked) },
    });

    await client.reader('previews').readBytes(REFERENCE);
    await client.reader('player').readBytes(REFERENCE);

    expect(asked).toEqual([`https://previews.example.com/bytes/${REFERENCE}`, `${BACKUP}/bytes/${REFERENCE}`]);
  });

  it("reads from a viewer's own gateway, with the deployment's fallback behind it", async () => {
    const asked: string[] = [];
    const own = { id: 'own-node', kind: 'bee-http' as const, url: 'http://localhost:1633' };
    const client = createSwarmClient(TWO_GATEWAYS, { choice: own, environment: { fetcher: primaryDownFetch(asked) } });

    await client.reader('previews').readBytes(REFERENCE);

    expect(asked).toEqual([`http://localhost:1633/bytes/${REFERENCE}`]);
    expect(client.health().map(({ id }) => id)).toEqual(['own-node', 'backup']);
  });
});
