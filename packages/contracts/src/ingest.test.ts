import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildIngestStreamId,
  buildObsSrtServer,
  buildRtmpServer,
  buildRtmpStreamKey,
  buildSrtPublishUrl,
  PUBLISH_KEY_PARAM,
  rtmpUnencryptedWarning,
} from './ingest.js';

const endpoint = { host: 'ingest.example.org', srtPort: 10061, rtmpPort: 10062 };
const topic = '1867808f-7b1c-4e46-b437-f7423b466b39';
const key = '0123456789abcdef0123456789abcdef';

describe('the addresses a broadcaster sends to', () => {
  it('names a stream by its application and its stream, and a key by the key parameter', () => {
    assert.equal(buildIngestStreamId('video', topic), `video/${topic}`);
    assert.equal(PUBLISH_KEY_PARAM, 'key');
  });

  it('writes the SRT line with the key inside the stream id, and without one when there is no key', () => {
    assert.equal(
      buildSrtPublishUrl(endpoint, `video/${topic}`, key),
      `srt://ingest.example.org:10061?streamid=#!::r=video/${topic}?key=${key},m=publish`,
    );
    assert.equal(
      buildSrtPublishUrl(endpoint, 'live/stream'),
      'srt://ingest.example.org:10061?streamid=#!::r=live/stream,m=publish',
    );
  });

  it('splits RTMP into a server by application and a stream key', () => {
    assert.equal(buildRtmpServer(endpoint, 'audio'), 'rtmp://ingest.example.org:10062/audio');
    assert.equal(buildRtmpStreamKey(topic, key), `${topic}?key=${key}`);
  });
});

describe('the OBS server line for SRT', () => {
  const srtUrl = buildSrtPublishUrl(endpoint, `video/${topic}`, key);

  it('carries a passphrase of unreserved characters', () => {
    assert.deepEqual(buildObsSrtServer(srtUrl, 'Unreserved-only_0123.456~ABCxyz9'), {
      server: `${srtUrl}&passphrase=Unreserved-only_0123.456~ABCxyz9`,
      passphraseRoute: 'server',
    });
  });

  it("leaves any other passphrase to OBS's own field, and says when there is none", () => {
    assert.deepEqual(buildObsSrtServer(srtUrl, 'has&amp'), { server: srtUrl, passphraseRoute: 'authentication' });
    assert.deepEqual(buildObsSrtServer(srtUrl, null), { server: srtUrl, passphraseRoute: 'none' });
  });
});

describe('what a console says beside RTMP', () => {
  it("gives the web2 admin's OBS panel and the manager's Publish card the same warning, each naming its own owner", () => {
    assert.equal(
      rtmpUnencryptedWarning('stage'),
      'RTMP is not encrypted. Your stream key crosses the network as readable text, and anyone who reads it there can publish to this stream with it. On a stage that lets a reconnecting encoder replace one whose connection dropped, they can also replace your live broadcast with theirs. On a network you do not trust, broadcast over SRT with a passphrase instead.',
    );
    assert.equal(
      rtmpUnencryptedWarning('deployment'),
      rtmpUnencryptedWarning('stage').replace('On a stage that', 'On a deployment that'),
    );
  });

  it('carries no em dash and no semicolon', () => {
    for (const owner of ['stage', 'deployment'] as const) {
      const warning = rtmpUnencryptedWarning(owner);
      assert.ok(!warning.includes('\u2014'), warning);
      assert.ok(!warning.includes(';'), warning);
    }
  });
});
