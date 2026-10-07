import { Topic } from '@ethersphere/bee-js';
import { describe, expect, it } from 'vitest';

import { statusRows } from '../src/components/DomainSelector/providerStatus';
import { testProvider } from '../src/components/DomainSelector/providerTest';
import { reportText } from '../src/components/DomainSelector/report';
import { loadUrl } from '../src/swarm/client';
import { createSwarmClient } from '../src/swarm/createSwarmClient';
import { gatewayName, parseProvidersSetting, swarmSettingsFrom } from '../src/swarm/settings';

const EVENT = 'https://event.example.com';
const BACKUP = 'https://backup.example.com';
/** The node a viewer saved in their browser, which is theirs and must not travel in a report of another. */
const SAVED_OWN_NODE = 'http://localhost:1633';
const CATALOG = { owner: '1'.repeat(40), topic: 'event-streams' };

const settings = swarmSettingsFrom({
  beeUrl: '/bee',
  providers: parseProvidersSetting(
    JSON.stringify({
      gateways: [
        { id: 'event', kind: 'bee-http', label: 'Event gateway', url: EVENT },
        { id: 'backup', kind: 'bee-http', url: BACKUP },
      ],
      default: 'event',
    }),
  ),
});

/** Answers every request with a 502, so every sentence about a failure is in the report. */
const failing = (async () => new Response('', { status: 502 })) as typeof fetch;

async function reportOfBackup(): Promise<string> {
  // The app's own client, on the viewer's own node.
  const inUse = createSwarmClient(settings, {
    choice: { id: 'own-node', kind: 'bee-http', url: SAVED_OWN_NODE },
    environment: { fetcher: failing },
  });
  await inUse.reader('player').readBytes('ab'.repeat(32));
  await inUse.reader('stream-list').readFeedHead(CATALOG.owner, Topic.fromString(CATALOG.topic));

  const backup = settings.gateways.find(({ id }) => id === 'backup')!;
  const results = await testProvider({
    client: createSwarmClient(
      { gateways: [backup], defaultId: backup.id, fallbackId: null, kinds: [backup.kind] },
      { environment: { fetcher: failing } },
    ),
    address: backup.url,
    catalog: CATALOG,
    knownStreams: [
      {
        owner: 'e'.repeat(40),
        topic: 'main-stage',
        title: 'Main stage',
        timestamp: 0,
        mediatype: 'video',
        state: 'vod',
        index: 3,
        thumbnail: 'f'.repeat(64),
      },
    ],
    pageProtocol: 'https:',
    loadUrl: (url, options) => loadUrl(url, { ...options, fetcher: failing }),
  });

  return reportText({
    tested: { name: gatewayName(settings, backup.id), address: backup.url, results },
    status: statusRows(inUse.activity(), inUse.health(), Date.now(), (id) => gatewayName(settings, id)),
    build: '@swarm-hls-stream/client 0.1.0, built 2026-10-07T00:00:00.000Z',
    browser: 'Mozilla/5.0 (test)',
    atMs: Date.UTC(2026, 9, 7, 12),
  });
}

describe("the node picker's report", () => {
  it('holds the test, the status, the build and the browser', async () => {
    const report = await reportOfBackup();

    expect(report).toContain('Test of Gateway backup (https://backup.example.com)');
    expect(report).toContain(
      'Video: failed. The gateway answered with an error (HTTP 502). Test again in a minute, or pick another gateway.',
    );
    expect(report).toContain('Video: Reads from Your own node');
    expect(report).toContain('Falls back to Event gateway');
    expect(report).toContain('Build: @swarm-hls-stream/client 0.1.0');
    expect(report).toContain('Browser: Mozilla/5.0 (test)');
    expect(report).not.toContain('Chat');
  });

  it("holds no address but the tested gateway's, and nothing from the viewer's saved node", async () => {
    const report = await reportOfBackup();

    for (const kept of [EVENT, SAVED_OWN_NODE, 'localhost', CATALOG.owner]) {
      expect(report).not.toContain(kept);
    }
    expect(report.match(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi)).toEqual([BACKUP]);
    expect(report).not.toMatch(/[0-9a-f]{40}/i);
  });

  it('says when no gateway was tested', () => {
    expect(reportText({ tested: null, status: [], build: 'b', browser: 'x', atMs: 0 })).toContain(
      'No gateway was tested.',
    );
  });
});

describe('the name a viewer is shown a gateway by', () => {
  it('is its label, the default gateway, their own node, or its id, and never its address', () => {
    const bare = swarmSettingsFrom({ beeUrl: EVENT, providers: null });

    expect(gatewayName(settings, 'event')).toBe('Event gateway');
    expect(gatewayName(settings, 'backup')).toBe('Gateway backup');
    expect(gatewayName(settings, 'own-node')).toBe('Your own node');
    expect(gatewayName(bare, 'gateway')).toBe('Default gateway');
  });
});
