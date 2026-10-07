import { describe, expect, it } from 'vitest';

import {
  beeBaseUrlFromTypedAddress,
  describeProbeFailure,
  isBlockedAsMixedContent,
  probeFailureHelp,
  probeGateway,
  sourceAddressFromTyped,
} from '@/components/DomainSelector/gatewayProbe';
import {
  corsHelp,
  LOCAL_HTTP_UNSUPPORTED,
  LOCAL_NETWORK_HELP,
  MIXED_CONTENT,
  notReadySentence,
  UNREACHABLE_SENTENCES,
} from '@/components/DomainSelector/checkSentences';
import { PROBE_TIMEOUT_MS, type ProbeResult, type ReadOptions } from '@/swarm/provider';
import { BeeHttpProvider } from '@/swarm/providers/bee-http/beeHttpProvider';

/**
 * That the Bee node picker reads an address before it saves it, and says what it found in words a
 * viewer can act on.
 *
 * Saving whatever was typed is how a viewer reached a browse page with nothing on it. The node was
 * not there, or it was there and refused this site's origin, and neither of those reached them as
 * anything other than an empty catalog. A browser reports a CORS refusal exactly like a closed port,
 * so the copy has to name both.
 *
 * The asking belongs to the provider's `probe()`, which owns the window and has its own test for it,
 * so nothing here re-checks that a timer fires. What these check is the window the picker asks for
 * and the reading it takes from what the probe found.
 */

const BEE_HEALTH = '{"status":"ok","version":"2.8.2","apiVersion":"7.3.0"}';

/** A single-page app answers every path with its index page and a 200, this project's own client included. */
const SPA_INDEX = '<!doctype html><html><head><title>Multimedia Streaming over Swarm</title></head></html>';

/** A Bee node over HTTP at the address the picker probes, answered by `fetcher`. */
function beeAnsweredBy(fetcher: typeof fetch) {
  return (url: string) => new BeeHttpProvider({ baseUrl: url, fetcher });
}

function answering(status: number, text = BEE_HEALTH) {
  return beeAnsweredBy((async () => new Response(text, { status })) as typeof fetch);
}

/** A browser without Local Network Access, so no permission is asked. */
const NO_LOCAL_NETWORK = { localNetworkRequests: false } as const;

/** One rejection stands for a closed port, a DNS miss and a CORS refusal, which a browser never tells apart. */
function refusing() {
  return beeAnsweredBy((async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch);
}

/** A node that accepts the connection and then goes quiet, which the provider's probe finds as timed out. */
function silent() {
  return () => ({ probe: async (): Promise<ProbeResult> => ({ kind: 'timed-out' }) });
}

describe('beeBaseUrlFromTypedAddress', () => {
  it('strips whitespace and trailing slashes, because every caller appends its own path', () => {
    expect(beeBaseUrlFromTypedAddress('  http://localhost:1633///  ')).toBe('http://localhost:1633');
  });

  it('adds http:// to a bare host and port, which is how an address is copied out of Swarm Desktop', () => {
    expect(beeBaseUrlFromTypedAddress('localhost:1633')).toBe('http://localhost:1633');
    expect(beeBaseUrlFromTypedAddress('192.168.1.20:1633')).toBe('http://192.168.1.20:1633');
  });

  it('leaves an explicit scheme alone, whatever its case', () => {
    expect(beeBaseUrlFromTypedAddress('HTTPS://gateway.example')).toBe('HTTPS://gateway.example');
  });

  it('keeps a path-only address such as the deployed default as it is', () => {
    expect(beeBaseUrlFromTypedAddress('/bee/')).toBe('/bee');
  });

  it('returns an empty string for nothing, so the picker can refuse it', () => {
    expect(beeBaseUrlFromTypedAddress('   ')).toBe('');
  });
});

describe('probeGateway', () => {
  it('asks the health endpoint under the address it was given', async () => {
    const asked: string[] = [];
    const prober = beeAnsweredBy((async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(BEE_HEALTH);
    }) as typeof fetch);

    await probeGateway('http://localhost:1633', { prober });

    // Bee's health document, which a /bee proxy on this site forwards unchanged.
    expect(asked).toContain('http://localhost:1633/health');
  });

  it('bounds its own wait at the window it ships with, so a node that goes quiet cannot hold the picker open', async () => {
    let window: number | undefined;
    const prober = () => ({
      probe: async (options?: ReadOptions): Promise<ProbeResult> => {
        window = options?.timeoutMs;
        return { kind: 'ok', elapsedMs: 1 };
      },
    });

    await probeGateway('http://localhost:1633', { prober });

    // The constant itself, not a lower bound. Above zero is satisfied by ten minutes, which is the
    // picker held open rather than a wait with an end.
    expect(window).toBe(PROBE_TIMEOUT_MS);
  });

  /**
   * The line above proves the probe uses the window it declares, and says nothing about the window
   * being short. A ceiling rather than the shipped value, so tuning the constant is free and a
   * viewer left staring at "Checking the node..." is not.
   */
  it('keeps that window short enough that a viewer waits rather than gives up', () => {
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('accepts an address that answers with a Bee health document', async () => {
    expect(await probeGateway('http://localhost:1633', { prober: answering(200) })).toEqual({ kind: 'ok' });
  });

  it('refuses a single-page app that answers 200 with its index page', async () => {
    expect(await probeGateway('http://localhost:4173', { prober: answering(200, SPA_INDEX) })).toEqual({
      kind: 'not-bee',
    });
  });

  it('accepts a Bee node whose health says nok, because it is still a Bee node', async () => {
    expect(await probeGateway('http://localhost:1633', { prober: answering(200, '{"status":"nok"}') })).toEqual({
      kind: 'ok',
    });
  });

  it('reports the status when something answers with an error', async () => {
    expect(await probeGateway('http://localhost:8080', { prober: answering(404) })).toEqual({
      kind: 'rejected',
      status: 404,
    });
  });

  it('names a node that answered and refused this site, which the probe found by asking again without CORS', async () => {
    const prober = () => ({ probe: async (): Promise<ProbeResult> => ({ kind: 'refuses-this-site' }) });
    expect(await probeGateway('http://localhost:1633', { prober })).toEqual({
      kind: 'unreachable',
      cause: { kind: 'cors-refused' },
    });
  });

  it("asks the browser's local network permission for a node on this computer that answered nothing", async () => {
    const reachability = { pageUrl: 'https://viewer.example.com/', permission: async () => 'denied' as const };
    expect(
      await probeGateway('http://localhost:1633', { prober: refusing(), localNetworkRequests: true, reachability }),
    ).toEqual({ kind: 'unreachable', cause: { kind: 'local-network-refused' } });
  });

  it('reports a refusal rather than throwing, so the picker always has something to show', async () => {
    expect(await probeGateway('http://localhost:1', { prober: refusing(), reachability: NO_LOCAL_NETWORK })).toEqual({
      kind: 'unreachable',
      cause: { kind: 'unreachable' },
    });
  });

  it('keeps a node that never answered apart from one that could not be reached', async () => {
    expect(await probeGateway('http://localhost:1633', { prober: silent(), reachability: NO_LOCAL_NETWORK })).toEqual({
      kind: 'timed-out',
      awaitingLocalNetwork: false,
    });
  });

  it("finds a node that never answered may be held by the browser's unanswered local network question", async () => {
    const reachability = { pageUrl: 'https://viewer.example.com/', permission: async () => 'prompt' as const };
    expect(
      await probeGateway('http://localhost:1633', { prober: silent(), localNetworkRequests: true, reachability }),
    ).toEqual({ kind: 'timed-out', awaitingLocalNetwork: true });
  });

  it('does not blame the local network question once it is answered, or where it is not asked', async () => {
    const granted = { pageUrl: 'https://viewer.example.com/', permission: async () => 'granted' as const };
    const samePlace = { pageUrl: 'http://localhost:5173/', permission: async () => 'prompt' as const };
    for (const reachability of [granted, samePlace]) {
      expect(
        await probeGateway('http://localhost:1633', { prober: silent(), localNetworkRequests: true, reachability }),
      ).toEqual({ kind: 'timed-out', awaitingLocalNetwork: false });
    }
  });
});

/**
 * ⛔ A node on the viewer's own network, named from the deployed site, never gets a request at all.
 *
 * The site is served over TLS and a browser refuses a plain `http` subresource from an `https` page,
 * before anything is sent. What the probe saw was the same `TypeError` a closed port produces, so the
 * picker told the viewer their node might not be running and to set `cors-allowed-origins` to `*` and
 * restart it. They can do that as often as they like and nothing changes, because the request never
 * left the page.
 *
 * `beeBaseUrlFromTypedAddress` puts `http://` in front of a bare host and port, which is how an
 * address is copied out of Swarm Desktop, so this is the ordinary path into it rather than an exotic
 * one.
 */
describe('a plain http node named from an https page', () => {
  /** Any call is a failure: the point is that the probe decides this without asking anything. */
  const neverAsked = (url: string) => ({
    probe: async (): Promise<ProbeResult> => {
      throw new Error(`the probe asked ${url}, which a browser would have refused to send`);
    },
  });

  it('is refused as mixed content rather than sent and misread as unreachable', async () => {
    expect(await probeGateway('http://192.0.2.10:1633', { pageProtocol: 'https:', prober: neverAsked })).toEqual({
      kind: 'mixed-content',
    });
  });

  it('says what would actually help, rather than naming a setting that cannot', async () => {
    const message = describeProbeFailure({ kind: 'mixed-content' });

    expect(message).not.toContain('cors-allowed-origins');
    expect(message).toBe(MIXED_CONTENT);
  });

  it("still asks loopback, which browsers exempt, so a node on the viewer's own machine works", async () => {
    const asked: string[] = [];
    const prober = beeAnsweredBy((async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(BEE_HEALTH);
    }) as typeof fetch);

    expect(await probeGateway('http://localhost:1633', { pageProtocol: 'https:', prober })).toEqual({ kind: 'ok' });
    expect(await probeGateway('http://127.0.0.1:1633', { pageProtocol: 'https:', prober })).toEqual({ kind: 'ok' });
    expect(asked.filter((url) => url.endsWith('/health'))).toHaveLength(2);
  });

  it('leaves an https node and a page served over http alone', () => {
    expect(isBlockedAsMixedContent('https://node.example:1633', 'https:', false)).toBe(false);
    expect(isBlockedAsMixedContent('http://192.168.1.20:1633', 'http:', false)).toBe(false);
  });

  it("leaves the deployed default alone, which is a path on this page's own origin", () => {
    expect(isBlockedAsMixedContent('/bee', 'https:', false)).toBe(false);
  });
});

/**
 * Chrome and Edge let an https page reach a plain http node on the local network, and other browsers
 * block it as mixed content before anything is sent. Which one this is is read off the browser's
 * Permissions API, so the probe takes the answer as an option.
 */
describe('a plain http node on the local network named from an https page', () => {
  const neverAsked = (url: string) => ({
    probe: async (): Promise<ProbeResult> => {
      throw new Error(`the probe asked ${url}, which this browser would have refused to send`);
    },
  });

  it('is asked in a browser that can mark a request as meant for the local network', async () => {
    expect(
      await probeGateway('http://192.168.1.20:1633', {
        pageProtocol: 'https:',
        localNetworkRequests: true,
        prober: answering(200),
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('is refused in any other browser, with a sentence naming the browsers that can', async () => {
    expect(
      await probeGateway('http://192.168.1.20:1633', {
        pageProtocol: 'https:',
        localNetworkRequests: false,
        prober: neverAsked,
      }),
    ).toEqual({ kind: 'local-http-unsupported' });
    expect(describeProbeFailure({ kind: 'local-http-unsupported' })).toBe(LOCAL_HTTP_UNSUPPORTED);
    expect(LOCAL_HTTP_UNSUPPORTED).toContain('Chrome');
  });

  it('is still mixed content on the internet, whatever the browser', () => {
    expect(isBlockedAsMixedContent('http://192.0.2.10:1633', 'https:', true)).toBe(true);
    expect(isBlockedAsMixedContent('http://192.168.1.20:1633', 'https:', true)).toBe(false);
    expect(isBlockedAsMixedContent('http://192.168.1.20:1633', 'https:', false)).toBe(true);
  });
});

describe('a Bee node that answers but cannot serve this viewer yet', () => {
  it.each([
    [{ kind: 'starting' } as const],
    [{ kind: 'no-peers' } as const],
    [{ kind: 'too-old', version: '2.2.0', needed: '2.3.0' } as const],
  ])('is not switched to when it is %o, and says so', async (reason) => {
    const prober = () => ({ probe: async (): Promise<ProbeResult> => ({ kind: 'not-ready', reason }) });
    const outcome = await probeGateway('http://localhost:1633', { prober });

    expect(outcome).toEqual({ kind: 'not-ready', reason });
    expect(describeProbeFailure({ kind: 'not-ready', reason })).toBe(notReadySentence(reason));
  });
});

describe('describeProbeFailure', () => {
  it('tells a viewer whose node answers and refuses this site about CORS, with the lines to add', () => {
    const failure = { kind: 'unreachable', cause: { kind: 'cors-refused' } } as const;

    expect(describeProbeFailure(failure)).toBe(UNREACHABLE_SENTENCES['cors-refused']);
    expect(probeFailureHelp(failure, 'https://viewer.example.com')).toEqual(corsHelp('https://viewer.example.com'));
  });

  it('sends a viewer whose address has nothing behind it to the node, with no CORS help', () => {
    const failure = { kind: 'unreachable', cause: { kind: 'unreachable' } } as const;

    expect(describeProbeFailure(failure)).not.toContain('cors-allowed-origins');
    expect(probeFailureHelp(failure, 'https://viewer.example.com')).toBeNull();
  });

  it("explains the browser's local network question where it may be the cause", () => {
    for (const kind of ['local-network-refused', 'unreachable-local'] as const) {
      const failure = { kind: 'unreachable', cause: { kind } } as const;
      expect(describeProbeFailure(failure)).toBe(UNREACHABLE_SENTENCES[kind]);
      expect(probeFailureHelp(failure, 'https://viewer.example.com')).toBe(LOCAL_NETWORK_HELP);
    }
  });

  it('sends a viewer whose node never answered to the node rather than to its CORS settings', () => {
    const timedOut = describeProbeFailure({ kind: 'timed-out', awaitingLocalNetwork: false });

    expect(timedOut).not.toContain('cors-allowed-origins');
    expect(timedOut).not.toBe(describeProbeFailure({ kind: 'unreachable', cause: { kind: 'unreachable' } }));
    expect(
      probeFailureHelp({ kind: 'timed-out', awaitingLocalNetwork: false }, 'https://viewer.example.com'),
    ).toBeNull();
  });

  it("sends a viewer whose node never answered to the browser's local network question while it is unanswered", () => {
    const failure = { kind: 'timed-out', awaitingLocalNetwork: true } as const;

    expect(describeProbeFailure(failure)).toBe(UNREACHABLE_SENTENCES['unreachable-local']);
    expect(probeFailureHelp(failure, 'https://viewer.example.com')).toBe(LOCAL_NETWORK_HELP);
  });

  it('names the status when something answered with an error', () => {
    expect(describeProbeFailure({ kind: 'rejected', status: 502 })).toContain('502');
  });

  it('says plainly that the thing answering is not a Bee node', () => {
    expect(describeProbeFailure({ kind: 'not-bee' })).toContain('not a Bee node');
  });
});

describe('the address of a source a viewer adds', () => {
  it('takes a gateway typed without a scheme as https, and a Bee node as http', () => {
    expect(sourceAddressFromTyped('gateway', ' gateway.example.com/ ')).toBe('https://gateway.example.com');
    expect(sourceAddressFromTyped('bee-node', 'localhost:1633')).toBe('http://localhost:1633');
  });

  it('keeps a scheme as typed and a path on this site for either, and nothing for a blank', () => {
    expect(sourceAddressFromTyped('gateway', 'http://192.0.2.10:1633')).toBe('http://192.0.2.10:1633');
    expect(sourceAddressFromTyped('gateway', '/bee/')).toBe('/bee');
    expect(sourceAddressFromTyped('bee-node', '/bee')).toBe('/bee');
    expect(sourceAddressFromTyped('gateway', '   ')).toBe('');
  });
});
