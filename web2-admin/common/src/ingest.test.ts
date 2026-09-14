import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIngestStreamId,
  buildRtmpServer,
  buildRtmpStreamKey,
  buildSrtPublishUrl,
} from './ingest.js';

const endpoint = { host: 'ingest.example.com', srtPort: 10061, rtmpPort: 10062 };
const topic = '1867808f-7b1c-4e46-b437-f7423b466b39';
const key = '0123456789abcdef0123456789abcdef';

test('ingest stream id is app/stream', () => {
  assert.equal(buildIngestStreamId('video', topic), `video/${topic}`);
});

test('SRT publish URL follows the publisher-auth shape', () => {
  assert.equal(
    buildSrtPublishUrl(endpoint, `video/${topic}`, key),
    `srt://ingest.example.com:10061?streamid=#!::r=video/${topic}?key=${key},m=publish`,
  );
});

test('RTMP server and stream key split app from stream', () => {
  assert.equal(buildRtmpServer(endpoint, 'audio'), 'rtmp://ingest.example.com:10062/audio');
  assert.equal(buildRtmpStreamKey(topic, key), `${topic}?key=${key}`);
});
