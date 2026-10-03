/**
 * What the Publish card says beside RTMP.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * RTMP has no passphrase, so the stream key crosses the network as readable
 * text. The web2 admin's OBS panel warns a broadcaster of it, and the Publish
 * card offers the same RTMP details, so it gives the same warning.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OBS_SERVER_BOX,
  OBS_STREAM_KEY_BOX,
  publishCopyText,
  RTMP_BOXES_NOTE,
  RTMP_UNENCRYPTED_WARNING,
} from './publishText';

describe('the Publish card beside RTMP', () => {
  it('warns that RTMP is not encrypted, what a key read off the network allows, and that SRT does not hide it', () => {
    assert.match(RTMP_UNENCRYPTED_WARNING, /^RTMP is not encrypted\./);
    assert.match(RTMP_UNENCRYPTED_WARNING, /anyone who reads it there can publish to this stream with it/);
    assert.match(RTMP_UNENCRYPTED_WARNING, /they can also replace your live broadcast with theirs/);
    assert.match(
      RTMP_UNENCRYPTED_WARNING,
      /while this deployment takes RTMP, a key read off an SRT connection publishes over RTMP too\.$/,
    );
  });

  it('labels each value with the name of the OBS box it goes in', () => {
    assert.deepEqual([OBS_SERVER_BOX, OBS_STREAM_KEY_BOX], ['Server', 'Stream Key']);
    assert.match(RTMP_BOXES_NOTE, /^Each goes in the OBS box of the same name\./);
  });

  it('carries no em dash and no semicolon', () => {
    for (const text of [RTMP_UNENCRYPTED_WARNING, RTMP_BOXES_NOTE]) {
      assert.ok(!text.includes('\u2014'), `an em dash in: ${text}`);
      assert.ok(!text.includes(';'), `a semicolon in: ${text}`);
    }
  });
});

// The deployment header, the deployments list and the overview each copy this text.
describe('what Copy publish URL puts on the clipboard', () => {
  const SRT_LINE = 'srt://stream.example:10061?streamid=#!::r=live/stream,m=publish&passphrase=plain.pass_word~-1';
  const RTMP = { server: 'rtmp://stream.example:10062/live', streamKey: 'stream' };

  it('is the SRT line alone when the deployment has no RTMP', () => {
    assert.equal(publishCopyText(SRT_LINE, null), SRT_LINE);
  });

  it('adds the RTMP server and stream key, named by their OBS boxes, when RTMP is open', () => {
    assert.equal(
      publishCopyText(SRT_LINE, RTMP),
      [`SRT: ${SRT_LINE}`, 'RTMP Server: rtmp://stream.example:10062/live', 'RTMP Stream Key: stream'].join('\n'),
    );
  });

  it('carries the SRT passphrase exactly where the SRT line does and adds none to RTMP', () => {
    const lines = publishCopyText(SRT_LINE, RTMP).split('\n');
    assert.deepEqual(
      lines.map((line) => line.includes('passphrase=')),
      [true, false, false],
    );
  });
});
