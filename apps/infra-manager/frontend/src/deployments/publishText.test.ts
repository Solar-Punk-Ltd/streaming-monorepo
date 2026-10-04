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
  publishesWithSrtPassphrase,
  RTMP_BOXES_NOTE,
  rtmpUnencryptedWarning,
} from './publishText';
import type { Profile } from '../types';

describe('the Publish card beside RTMP', () => {
  it('warns that RTMP is not encrypted, what a key read off the network allows, and what SRT keeps', () => {
    const warning = rtmpUnencryptedWarning(true);
    assert.match(warning, /^RTMP is not encrypted, so your stream key crosses the network as readable text\./);
    assert.match(warning, /A key read off the network publishes to this stream over RTMP/);
    assert.match(warning, /With the takeover on, a publisher with the key can also replace your live broadcast/);
    assert.match(warning, /This deployment's SRT passphrase keeps your picture private but not your key/);
  });

  it('does not recommend an SRT passphrase to a deployment that publishes without one', () => {
    const warning = rtmpUnencryptedWarning(false);
    assert.doesNotMatch(warning, /keeps your picture private/);
    assert.match(warning, /This deployment has no SRT passphrase, so the picture is not private either/);
  });

  it("counts the deployment's own passphrase or the host-wide one, as the SRT line does", () => {
    const own = { has_srt_passphrase: true } as Profile;
    const none = { has_srt_passphrase: false } as Profile;
    assert.equal(publishesWithSrtPassphrase(own, null), true);
    assert.equal(publishesWithSrtPassphrase(none, 'host-wide'), true);
    assert.equal(publishesWithSrtPassphrase(none, null), false);
  });

  it('labels each value with the name of the OBS box it goes in', () => {
    assert.deepEqual([OBS_SERVER_BOX, OBS_STREAM_KEY_BOX], ['Server', 'Stream Key']);
    assert.match(RTMP_BOXES_NOTE, /^Each goes in the OBS box of the same name\./);
  });

  it('carries no em dash and no semicolon', () => {
    for (const text of [rtmpUnencryptedWarning(true), rtmpUnencryptedWarning(false), RTMP_BOXES_NOTE]) {
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

  it('adds the RTMP server and stream key, named by their OBS boxes, where the engine takes RTMP', () => {
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
