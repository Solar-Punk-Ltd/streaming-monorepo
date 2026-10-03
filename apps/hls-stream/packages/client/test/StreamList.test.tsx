import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, vi } from 'vitest';

import { StreamList } from '../src/components/StreamList/StreamList';
import {
  MEDIA_TYPE_VIDEO,
  STREAM_STATUS_LIVE,
  STREAM_STATUS_SCHEDULED,
  STREAM_STATUS_VOD,
  type Stream,
  type StreamState,
} from '../src/types/stream';

/**
 * Which catalog entries the browse page lists, and in what order.
 *
 * The list used to keep only the last ten entries of the catalog before sorting them. The admin
 * appends each new stream at the end, so the entries it dropped were the oldest ones, the recordings
 * at the front: at eleven entries the first recording vanished from the page while it was still on
 * the feed. One catalog serves every stage of a brand, so ten entries come quickly.
 */
const catalog = vi.hoisted(() => ({ streamList: [] as Stream[] }));

vi.mock('../src/providers/App', () => ({
  useAppContext: () => ({ streamList: catalog.streamList }),
}));

// A card stands in for the preview, which needs a router and a gateway and is not what is tested here.
vi.mock('../src/components/StreamPreview/StreamPreview', async () => {
  const { createElement: h } = await import('react');
  return {
    StreamPreview: ({ topic }: { topic: string }) => h('div', { 'data-topic': topic }),
  };
});

function entry(position: number, state: StreamState): Stream {
  return {
    owner: '0xabc',
    topic: `topic-${position}`,
    state,
    timestamp: 1_000 + position,
    mediatype: MEDIA_TYPE_VIDEO,
    title: `stream ${position}`,
  };
}

function listedTopics(streamList: Stream[]): string[] {
  catalog.streamList = streamList;
  const html = renderToStaticMarkup(createElement(StreamList));
  return [...html.matchAll(/data-topic="([^"]+)"/g)].map(([, topic]) => topic);
}

describe('the stream list on the browse page', () => {
  it('lists every catalog entry, live first and then newest first', () => {
    // Twelve entries in the order the admin appends them, the oldest recording at the front.
    const streamList = Array.from({ length: 12 }, (_, position) => entry(position, STREAM_STATUS_VOD));
    streamList[4] = entry(4, STREAM_STATUS_LIVE);
    streamList[5] = entry(5, STREAM_STATUS_SCHEDULED);

    const topics = listedTopics(streamList);

    assert.ok(topics.includes('topic-0'), 'the oldest recording is still on the feed, so it is still listed');
    assert.deepEqual(topics, [
      'topic-4',
      'topic-11',
      'topic-10',
      'topic-9',
      'topic-8',
      'topic-7',
      'topic-6',
      'topic-5',
      'topic-3',
      'topic-2',
      'topic-1',
      'topic-0',
    ]);
  });
});
