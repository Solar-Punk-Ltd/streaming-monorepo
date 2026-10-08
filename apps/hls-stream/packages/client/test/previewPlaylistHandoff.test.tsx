// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import Hls, { type HlsConfig, type LoaderCallbacks, type PlaylistLoaderContext } from 'hls.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamPreview } from '../src/components/StreamPreview/StreamPreview';
import { MEDIA_TYPE_VIDEO, STREAM_STATUS_VOD } from '../src/types/stream';

const SEGMENT_URL = 'https://gateway.example.com/bytes/abc123';

vi.mock('../src/providers/App', () => ({
  useAppContext: () => ({ swarm: { reader: () => ({ urlFor: () => null }) } }),
}));

vi.mock('../src/components/StreamPreview/previewManifest', () => ({
  rungSlotsKey: () => '',
  fetchPreviewManifest: async () => ({
    res: { ok: true, status: 200 },
    segments: [{ extinf: '#EXTINF:2.000,', uri: SEGMENT_URL }],
  }),
}));

interface Handoff {
  url: string;
  config: HlsConfig;
}

let container: HTMLDivElement;
let root: Root;
let handoffs: Handoff[];
let createObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  handoffs = [];
  vi.spyOn(Hls.prototype, 'attachMedia').mockImplementation(() => undefined);
  vi.spyOn(Hls.prototype, 'loadSource').mockImplementation(function (this: Hls, url: string) {
    handoffs.push({ url, config: this.config });
  });
  // jsdom has no object URLs, and the page would have one, so a test that leaves this undefined would
  // fail on a TypeError rather than on what the card hands hls.js.
  createObjectURL = vi.fn(() => 'blob:http://viewer.example/0000');
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mountPreview() {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(StreamPreview, {
          owner: '0000000000000000000000000000000000000000',
          topic: 'stream-a',
          state: STREAM_STATUS_VOD,
          mediatype: MEDIA_TYPE_VIDEO,
          title: 'Stream A',
        }),
      ),
    );
  });
  await vi.waitFor(() => expect(handoffs).toHaveLength(1));
  return handoffs[0];
}

function loadPlaylist({ url, config }: Handoff): Promise<string> {
  const Loader = config.pLoader as unknown as new (config: HlsConfig) => {
    load(
      context: PlaylistLoaderContext,
      loaderConfig: unknown,
      callbacks: LoaderCallbacks<PlaylistLoaderContext>,
    ): void;
  };
  return new Promise((resolve, reject) => {
    new Loader(config).load(
      { url, type: 'manifest', responseType: 'text' } as PlaylistLoaderContext,
      {},
      {
        onSuccess: (response) => resolve(String(response.data)),
        onError: (error) => reject(new Error(error.text)),
        onTimeout: () => reject(new Error('timed out')),
      },
    );
  });
}

/**
 * The Devcon client's image names no blob source in connect-src, and hls.js reads a playlist with XHR,
 * so a card that handed it a blob URL showed nothing on that deployed site while every unpoliced run
 * passed. This image sets no policy yet, and the card keeps off blob URLs so one can stay that narrow.
 */
describe('a stream card hands hls.js its preview playlist', () => {
  it('without a blob URL, which the connect-src policy refuses', async () => {
    const handoff = await mountPreview();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(handoff.url).not.toMatch(/^blob:/);
  });

  it('through a playlist loader that answers that URL from memory, naming the segment', async () => {
    const playlist = await loadPlaylist(await mountPreview());

    expect(playlist).toMatch(/^#EXTM3U\n/);
    expect(playlist).toContain(`#EXTINF:2.000,\n${SEGMENT_URL}\n`);
    expect(playlist).toMatch(/#EXT-X-ENDLIST$/);
  });
});
