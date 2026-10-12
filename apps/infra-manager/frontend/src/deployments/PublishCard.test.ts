/**
 * The host a broadcaster sends to, which the Publish card names as Ingest beside the URL that carries it.
 *
 * Unit test: the card rendered to markup on the server, under the app's own theme, with no browser. `pnpm test` in
 * frontend/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ThemeProvider } from '@mui/material';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { theme } from '../app/theme';
import type { Profile } from '../types';
import { PublishCard } from './PublishCard';

const SERVER_HOST = 'ingest.example.org';

function stage(over: Partial<Profile> = {}): Profile {
  return {
    name: 'main-stage',
    kind: 'streamer',
    status: 'RUNNING',
    host: 'localhost',
    has_srt_passphrase: false,
    containers: [{ service: 'srs', ports: {} }],
    ...over,
  } as unknown as Profile;
}

function rendered(profile: Profile, ingestHost: string): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(PublishCard, {
        profile,
        url: `srt://${ingestHost}:10071?streamid=publish:live/stream`,
        serverHost: SERVER_HOST,
        hostPassphrase: null,
        ready: true,
        passphrasePending: false,
      }),
    ),
  ).replace(/<style[^>]*>.*?<\/style>/g, '');
}

/** The text that follows the Ingest label, or null when the card has no such label. */
function ingest(html: string): string | null {
  return /<span[^>]*>Ingest<\/span><p[^>]*>([^<]*)<\/p>/.exec(html)?.[1] ?? null;
}

describe('the Publish card', () => {
  it("names the host a broadcaster sends to as Ingest, the manager's own for a local deployment", () => {
    assert.equal(ingest(rendered(stage(), SERVER_HOST)), SERVER_HOST);
  });

  it("names a remote deployment's own host, not the manager's", () => {
    const remote = stage({ host: 'bee-host-1', network_host: '203.0.113.7' });

    assert.equal(ingest(rendered(remote, '203.0.113.7')), '203.0.113.7');
  });
});
