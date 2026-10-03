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

import { OBS_SERVER_BOX, OBS_STREAM_KEY_BOX, RTMP_BOXES_NOTE, RTMP_UNENCRYPTED_WARNING } from './publishText';

describe('the Publish card beside RTMP', () => {
  it('warns that RTMP is not encrypted, what a key read off the network allows, and to use SRT', () => {
    assert.match(RTMP_UNENCRYPTED_WARNING, /^RTMP is not encrypted\./);
    assert.match(RTMP_UNENCRYPTED_WARNING, /anyone who reads it there can publish to this stream with it/);
    assert.match(RTMP_UNENCRYPTED_WARNING, /they can also replace your live broadcast with theirs/);
    assert.match(
      RTMP_UNENCRYPTED_WARNING,
      /On a network you do not trust, broadcast over SRT with a passphrase instead\.$/,
    );
  });

  it('labels each value with the name of the OBS box it goes in', () => {
    assert.deepEqual([OBS_SERVER_BOX, OBS_STREAM_KEY_BOX], ['Server', 'Stream Key']);
    assert.match(RTMP_BOXES_NOTE, /^Each goes in the OBS box of the same name\./);
  });

  it('carries no em dash and no semicolon', () => {
    for (const text of [RTMP_UNENCRYPTED_WARNING, RTMP_BOXES_NOTE]) {
      assert.ok(!text.includes('—'), `an em dash in: ${text}`);
      assert.ok(!text.includes(';'), `a semicolon in: ${text}`);
    }
  });
});
