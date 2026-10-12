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

const profile = {
  name: 'main-stage',
  kind: 'streamer',
  status: 'RUNNING',
  has_srt_passphrase: false,
  containers: [{ service: 'srs', ports: {} }],
} as unknown as Profile;

function rendered(ingestHost: string): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(PublishCard, {
        profile,
        url: `srt://${ingestHost}:10071?streamid=publish:live/stream`,
        ingestHost,
        hostPassphrase: null,
        ready: true,
        passphrasePending: false,
      }),
    ),
  ).replace(/<style[^>]*>.*?<\/style>/g, '');
}

describe('the Publish card', () => {
  it('names the host a broadcaster sends to as Ingest', () => {
    const html = rendered('ingest.example.org');

    const label = html.indexOf('>Ingest<');
    assert.notEqual(label, -1, html);
    assert.ok(html.indexOf('>ingest.example.org<', label) > label, 'the host follows its label');
  });
});
