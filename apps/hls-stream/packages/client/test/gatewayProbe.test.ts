import { describe, expect, it } from 'vitest';

import {
  beeBaseUrlFromTypedAddress,
  describeProbeFailure,
  gatewayLabel,
  isBlockedAsMixedContent,
  isDefaultGateway,
  probeGateway,
} from '@/components/DomainSelector/gatewayProbe';
import { notReadySentence } from '@/components/DomainSelector/checkSentences';
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

  it('reports a refusal rather than throwing, so the picker always has something to show', async () => {
    expect(await probeGateway('http://localhost:1', { prober: refusing() })).toEqual({ kind: 'unreachable' });
  });

  it('keeps a node that never answered apart from one that could not be reached', async () => {
    expect(await probeGateway('http://localhost:1633', { prober: silent() })).toEqual({ kind: 'timed-out' });
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
    expect(await probeGateway('http://192.168.1.20:1633', { pageProtocol: 'https:', prober: neverAsked })).toEqual({
      kind: 'mixed-content',
    });
  });

  it('says what would actually help, rather than naming a setting that cannot', async () => {
    const message = describeProbeFailure({ kind: 'mixed-content' });

    expect(message).not.toContain('cors-allowed-origins');
    expect(message).toContain('http');
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
    expect(isBlockedAsMixedContent('https://node.example:1633', 'https:')).toBe(false);
    expect(isBlockedAsMixedContent('http://192.168.1.20:1633', 'http:')).toBe(false);
  });

  it("leaves the deployed default alone, which is a path on this page's own origin", () => {
    expect(isBlockedAsMixedContent('/bee', 'https:')).toBe(false);
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
  it('tells an unreachable viewer about CORS, because a browser hides that cause behind a failed fetch', () => {
    expect(describeProbeFailure({ kind: 'unreachable' })).toContain('cors-allowed-origins');
  });

  it('sends a viewer whose node never answered to the node rather than to its CORS settings', () => {
    const timedOut = describeProbeFailure({ kind: 'timed-out' });

    expect(timedOut).not.toContain('cors-allowed-origins');
    expect(timedOut).not.toBe(describeProbeFailure({ kind: 'unreachable' }));
  });

  it('names the status when something answered with an error', () => {
    expect(describeProbeFailure({ kind: 'rejected', status: 502 })).toContain('502');
  });

  it('says plainly that the thing answering is not a Bee node', () => {
    expect(describeProbeFailure({ kind: 'not-bee' })).toContain('not a Bee node');
  });
});

describe('the way back to the default gateway', () => {
  it('knows a viewer is on the default, so the way back is offered only when it does something', () => {
    expect(isDefaultGateway('/bee', '/bee')).toBe(true);
    expect(isDefaultGateway('http://localhost:1633', '/bee')).toBe(false);
  });

  it('still knows the default when the saved value lost a trailing slash the env var carries', () => {
    expect(isDefaultGateway('https://gateway.example', 'https://gateway.example/')).toBe(true);
  });

  it('names the default rather than showing a path a viewer has never seen', () => {
    expect(gatewayLabel('/bee', '/bee')).toBe('Default gateway');
  });

  it('shows a viewer their own node as its host, which is what they typed', () => {
    expect(gatewayLabel('http://localhost:1633', '/bee')).toBe('localhost:1633');
  });

  it('falls back to the raw value when it is not a URL', () => {
    expect(gatewayLabel('/other-proxy', '/bee')).toBe('/other-proxy');
  });
});
