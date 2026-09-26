import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIngestStreamId,
  buildObsSrtServer,
  buildRtmpServer,
  buildRtmpStreamKey,
  buildSrtPublishUrl,
} from './ingest.js';

const endpoint = { host: 'ingest.example.com', srtPort: 10061, rtmpPort: 10062 };
const topic = '1867808f-7b1c-4e46-b437-f7423b466b39';
const key = '0123456789abcdef0123456789abcdef';
const srtUrl = `srt://ingest.example.com:10061?streamid=#!::r=video/${topic}?key=${key},m=publish`;

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

test('the OBS Server line for SRT carries a passphrase made of unreserved characters', () => {
  const passphrase = 'Unreserved-only_0123.456~ABCxyz9';

  assert.deepEqual(buildObsSrtServer(srtUrl, passphrase), {
    server: `${srtUrl}&passphrase=${passphrase}`,
    passphraseRoute: 'server',
  });
});

test('a passphrase OBS would change on the Server line goes through Use authentication', () => {
  // OBS ends a value at `&`, turns `+` into a space and never percent-decodes.
  const changedByObs = ['has&ampersand01', 'has+plus0123456', 'has space 012345', 'has%25percent01'];
  for (const passphrase of changedByObs) {
    assert.deepEqual(
      buildObsSrtServer(srtUrl, passphrase),
      { server: srtUrl, passphraseRoute: 'authentication' },
      passphrase,
    );
  }
});

test('with no passphrase the OBS Server line for SRT is the URL itself', () => {
  const urlAlone = { server: srtUrl, passphraseRoute: 'none' };
  assert.deepEqual(buildObsSrtServer(srtUrl, null), urlAlone);
  assert.deepEqual(buildObsSrtServer(srtUrl, ''), urlAlone);
});

test('the passphrase opens the query when the URL has none yet', () => {
  const bareUrl = 'srt://ingest.example.com:10061';
  assert.deepEqual(buildObsSrtServer(bareUrl, 'abcdefghij'), {
    server: `${bareUrl}?passphrase=abcdefghij`,
    passphraseRoute: 'server',
  });
});
