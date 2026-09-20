/**
 * OBS connection details. Unit test — a row and the configured endpoint in,
 * strings out.
 *
 * The URL shapes themselves are pinned in web2-admin-common's own test; what
 * is pinned here is the assembly: which part of the row becomes the app, which
 * becomes the stream name, that the server-wide SRT passphrase is passed
 * through rather than invented per stream, and that `keyVerified` reflects
 * config so the console can warn while the ingest ignores `key=`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ingestDetailsFor } from '../../src/domain/IngestService.js';
import type { IngestConfig } from '../../src/utils/config.js';

import { streamRow } from './support/fakes.js';

const endpoint: IngestConfig = {
  host: 'ingest.example.com',
  srtPort: 10061,
  rtmpPort: 10062,
  srtPassphrase: 'a-long-server-passphrase',
  keyVerified: false,
  managedLifecycle: null,
};

describe('ingestDetailsFor', () => {
  it('builds every field from the row and the endpoint', () => {
    const row = streamRow({
      media_type: 'video',
      publish_key: '0123456789abcdef0123456789abcdef',
      publish_key_rotated_at: new Date('2026-09-11T12:00:00.000Z'),
    });

    assert.deepEqual(ingestDetailsFor(row, endpoint), {
      streamId: `video/${row.topic}`,
      app: 'video',
      stream: row.topic,
      publishKey: '0123456789abcdef0123456789abcdef',
      publishKeyRotatedAt: '2026-09-11T12:00:00.000Z',
      srt: {
        url: `srt://ingest.example.com:10061?streamid=#!::r=video/${row.topic}?key=0123456789abcdef0123456789abcdef,m=publish`,
        passphrase: 'a-long-server-passphrase',
      },
      rtmp: {
        server: 'rtmp://ingest.example.com:10062/video',
        streamKey: `${row.topic}?key=0123456789abcdef0123456789abcdef`,
      },
      keyVerified: false,
    });
  });

  it('uses the media type as the SRS app, so audio lands on the audio path', () => {
    const row = streamRow({ media_type: 'audio' });
    const details = ingestDetailsFor(row, endpoint);

    assert.equal(details.app, 'audio');
    assert.equal(details.streamId, `audio/${row.topic}`);
    assert.equal(details.rtmp.server, 'rtmp://ingest.example.com:10062/audio');
    assert.match(details.srt.url, new RegExp(`r=audio/${row.topic}`));
  });

  it('reports no passphrase when SRT is unencrypted', () => {
    const details = ingestDetailsFor(streamRow(), {
      ...endpoint,
      srtPassphrase: null,
    });
    assert.equal(details.srt.passphrase, null);
  });

  it('carries keyVerified through from config', () => {
    const details = ingestDetailsFor(streamRow(), {
      ...endpoint,
      keyVerified: true,
    });
    assert.equal(details.keyVerified, true);
  });

  it('has no rotation timestamp until the key is rotated', () => {
    assert.equal(
      ingestDetailsFor(streamRow(), endpoint).publishKeyRotatedAt,
      null,
    );
  });

  it('follows the port slot the endpoint was configured with', () => {
    const slotZero = ingestDetailsFor(streamRow(), {
      ...endpoint,
      srtPort: 10001,
      rtmpPort: 10002,
    });
    assert.match(slotZero.srt.url, /^srt:\/\/ingest\.example\.com:10001\?/);
    assert.equal(slotZero.rtmp.server, 'rtmp://ingest.example.com:10002/video');
  });
});
