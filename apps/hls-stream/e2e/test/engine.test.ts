import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { type E2EConfig, loadConfig, ROOT_DIR } from '../src/config.js';
import {
  getEngine,
  ingestUrl,
  SRS_OLD_CONNECTION_LEFT_AFTER_A_NEWER,
  SRS_RUNG_PUBLISHED,
  SRS_RUNG_UNPUBLISHED,
  srtIngestUrl,
} from '../src/harness/engine.js';
import { INGEST_RTMP, INGEST_SRT } from '../src/ingestProtocol.js';

/**
 * The SRT ingest URL is the one thing in the harness that no assertion downstream can catch being
 * wrong: a malformed streamid is refused during the handshake, no segment is ever produced, and
 * every scenario fails on its warmup wait rather than on what it was written to test.
 */

const roots: string[] = [];

after(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function config(env: NodeJS.ProcessEnv): E2EConfig {
  const rootDir = mkdtempSync(join(tmpdir(), 'e2e-engine-'));
  roots.push(rootDir);
  return loadConfig({ env: { E2E_PUBLIC_HOST: '203.0.113.10', ...env }, rootDir });
}

describe('SRS ingest', () => {
  // SRS's documented publish form. ffmpeg passes the literal `#!::r=...` through to libsrt, so the
  // `#` is not a fragment delimiter here and must survive into the URL as written.
  it('builds the #!::r= streamid with m=publish', () => {
    const cfg = config({ E2E_ENGINE: 'srs', E2E_PORT_SLOT: '2' });
    assert.equal(srtIngestUrl(cfg), 'srt://203.0.113.10:10021?streamid=#!::r=live/stream,m=publish');
  });

  it('follows the port slot, because SRS ingest is a profile service', () => {
    assert.match(srtIngestUrl(config({ E2E_ENGINE: 'srs', E2E_PORT_SLOT: '7' })), /:10071\?/);
  });

  it('restarts the srs container belonging to its own profile', () => {
    const cfg = config({ E2E_ENGINE: 'srs', E2E_PROFILE: 'streamer1' });
    assert.equal(getEngine(cfg).mediaContainer(cfg), 'streamer1-srs-1');
  });

  it('watches for the published and unpublished markers', () => {
    const engine = getEngine(config({ E2E_ENGINE: 'srs' }));
    assert.match('[SRS] Stream published: stream-7 (video)', engine.publishedMarker);
    assert.match('[SRS] Stream unpublished: stream-7', engine.unpublishedMarker);
    assert.doesNotMatch('[SRS] Stream unpublished: stream-7', engine.publishedMarker);
    // The ladder's SOURCE lines are the event; a rung's are not. Under a ladder the rungs unpublish
    // BEFORE the source session finishes dying, and a reconnect triggered on a rung line lands in
    // the tail of the old session, which SRS answers by dropping the new publisher.
    assert.match('[SRS] Ladder source authenticated: live/stream', engine.publishedMarker);
    assert.match('[SRS] Ladder source unpublished: live/stream', engine.unpublishedMarker);
    assert.doesNotMatch('[SRS] Rung published: live/stream_720p', engine.publishedMarker);
    assert.doesNotMatch('[SRS] Rung unpublished: live/stream_360p', engine.unpublishedMarker);
  });
});

describe('OME ingest', () => {
  // OME derives app and stream from the streamid, and the uploader's admission parser reads them
  // from a full srt:// URL, so one is embedded rather than the bare path SRS takes.
  it('embeds a full srt URL in the streamid', () => {
    const cfg = config({ E2E_ENGINE: 'ome' });
    assert.equal(srtIngestUrl(cfg), 'srt://203.0.113.10:10081?streamid=srt://203.0.113.10:10081/video/stream');
  });

  // The difference from SRS that a shared implementation would get wrong. OME's port comes from its
  // engine env and is never slot-shifted, so the ingest URL must not move with the slot.
  it('does not follow the port slot', () => {
    const withSlot = srtIngestUrl(config({ E2E_ENGINE: 'ome', E2E_PORT_SLOT: '5' }));
    const withoutSlot = srtIngestUrl(config({ E2E_ENGINE: 'ome' }));
    assert.equal(withSlot, withoutSlot, 'the OME ingest URL moved with the port slot');
  });

  it('restarts the ome container belonging to its own profile', () => {
    const cfg = config({ E2E_ENGINE: 'ome', E2E_PROFILE: 'streamer1' });
    assert.equal(getEngine(cfg).mediaContainer(cfg), 'streamer1-ome-1');
  });

  it('watches for the opening and closing markers', () => {
    const engine = getEngine(config({ E2E_ENGINE: 'ome' }));
    assert.match('[OME] Stream opening: stream-7 (video)', engine.publishedMarker);
    assert.match('[OME] Stream closing: stream-7', engine.unpublishedMarker);
  });

  // OME cold-starts slower than SRS, and a grace shared between them would either race OME's
  // restart or waste time on every SRS run.
  it('allows a longer reconnect grace than SRS', () => {
    assert.ok(
      getEngine(config({ E2E_ENGINE: 'ome' })).reconnectGraceMs >
        getEngine(config({ E2E_ENGINE: 'srs' })).reconnectGraceMs,
    );
  });
});

describe('engine markers do not match the other engine', () => {
  // Both engines run the same downstream assertions, so a marker matching either would let an SRS
  // run pass while attached to an OME deployment, reporting on a stack it never drove.
  it('keeps the SRS and OME markers disjoint', () => {
    const srs = getEngine(config({ E2E_ENGINE: 'srs' }));
    const ome = getEngine(config({ E2E_ENGINE: 'ome' }));
    assert.doesNotMatch('[OME] Stream opening: s', srs.publishedMarker);
    assert.doesNotMatch('[SRS] Stream published: s', ome.publishedMarker);
    assert.doesNotMatch('[OME] Stream closing: s', srs.unpublishedMarker);
    assert.doesNotMatch('[SRS] Stream unpublished: s', ome.unpublishedMarker);
  });
});

describe('a custom stream path reaches the URL', () => {
  it('is used by both engines', () => {
    assert.match(
      srtIngestUrl(config({ E2E_ENGINE: 'srs', E2E_STREAM_PATH: 'live/other' })),
      /r=live\/other,m=publish$/,
    );
    assert.match(srtIngestUrl(config({ E2E_ENGINE: 'ome', E2E_STREAM_PATH: 'audio/other' })), /\/audio\/other$/);
  });
});

/**
 * That the URL this suite dials carries the credential the deployment demands.
 *
 * Every scenario here published with no key at all until 2026-08-03, so against a deployment with
 * `PUBLISH_KEY_SECRET` set, all of them failed at the first admission. That failure is the expensive
 * kind: the engine refuses the handshake, no segment is produced, and each scenario waits out its
 * warmup and reports a publisher timeout, which reads as a broken stack rather than a missing key.
 *
 * **Pinned to the golden vector rather than to `derivePublishKey`'s own output**, which is the whole
 * point. Asserting the URL contains what the function just returned would pass with both sides
 * broken in the same direction. This literal is the same one `packages/stream-uploader` and
 * `deploy/test/publishKey.test.js` pin, so the publisher, the verifier and the operator CLI are three
 * independent files agreeing on one string. If they ever disagree, every key issued is refused and it
 * looks exactly like a broadcaster's typo.
 */
describe('the publish key in the ingest URL', () => {
  const GOLDEN_SECRET = 'publish-key-secret-0123456789abcdef';
  const GOLDEN_KEY = '2d1e344ecb833667c936399866349fbc';
  const GOLDEN_PATH = 'video/demo';

  it('SRS carries the key inside the r= value, ahead of m=publish', () => {
    const cfg = config({
      E2E_ENGINE: 'srs',
      E2E_STREAM_PATH: GOLDEN_PATH,
      PUBLISH_KEY_SECRET: GOLDEN_SECRET,
    });

    assert.match(srtIngestUrl(cfg), new RegExp(`streamid=#!::r=video/demo\\?key=${GOLDEN_KEY},m=publish$`));
  });

  it('OME carries the key in the nested streamid, percent-encoded', () => {
    const cfg = config({
      E2E_ENGINE: 'ome',
      E2E_STREAM_PATH: GOLDEN_PATH,
      PUBLISH_KEY_SECRET: GOLDEN_SECRET,
    });

    assert.ok(
      srtIngestUrl(cfg).includes(`%3Fkey%3D${GOLDEN_KEY}`),
      'the key has to survive into the streamid, and the second ? has to be encoded',
    );
  });

  /**
   * The property publisher authentication rests on, asserted where it can actually be got wrong. Deriving against the
   * secret alone, or against a constant, would authenticate every scenario against every stream, and
   * the multi-stream scenario is the only place that shows.
   */
  it('derives a different key per stream, so one scenario cannot publish as another', () => {
    const cfg = config({ E2E_ENGINE: 'srs', PUBLISH_KEY_SECRET: GOLDEN_SECRET });

    const mine = srtIngestUrl(cfg, 'live/one');
    const theirs = srtIngestUrl(cfg, 'live/two');

    assert.notEqual(mine, theirs);
    assert.equal(mine.includes(GOLDEN_KEY), false, 'and neither is the key for some third stream');
  });

  /** The keyless shape is the one confirmed live, so it is pinned byte for byte against drift. */
  it('leaves both URLs exactly as they were when no secret is configured', () => {
    const srs = config({ E2E_ENGINE: 'srs', E2E_PORT_SLOT: '2' });
    const ome = config({ E2E_ENGINE: 'ome' });

    assert.equal(srtIngestUrl(srs), 'srt://203.0.113.10:10021?streamid=#!::r=live/stream,m=publish');
    assert.equal(srtIngestUrl(ome).includes('key'), false);
    assert.equal(srtIngestUrl(ome).includes('%'), false, 'and it is not encoded either');
  });

  /**
   * A secret the service would have refused at startup fails here instead, because the alternative
   * is every scenario timing out against an uploader that never came up.
   */
  it('refuses a secret too short for the service to have accepted', () => {
    assert.throws(() => config({ E2E_ENGINE: 'srs', PUBLISH_KEY_SECRET: 'too-short' }), /at least 32 characters/);
  });
});

/**
 * The RTMP URL the publisher dials, which has to be exactly what a broadcaster is told to put into OBS.
 *
 * The admin hands a broadcaster two fields, a server `rtmp://<host>:<port>/<app>` and a stream key `<stream>?key=<key>`
 * (`buildRtmpServer` and `buildRtmpStreamKey` in `packages/contracts/src/ingest.ts`). OBS sends the first as the
 * connection's `tcUrl` and the second as the stream it publishes, and ffmpeg sends the same two out of one URL that
 * joins them with a slash. Pinned as literals for the reason the SRT shape above is: a URL a later change got wrong
 * would refuse every publish in the warmup, and read as a broken stack.
 */
describe('SRS ingest over RTMP', () => {
  const GOLDEN_SECRET = 'publish-key-secret-0123456789abcdef';
  const GOLDEN_KEY = '2d1e344ecb833667c936399866349fbc';

  it('joins the server and the stream key the admin hands a broadcaster', () => {
    const cfg = config({
      E2E_ENGINE: 'srs',
      E2E_PORT_SLOT: '6',
      E2E_STREAM_PATH: 'video/demo',
      PUBLISH_KEY_SECRET: GOLDEN_SECRET,
    });

    assert.equal(ingestUrl(cfg, INGEST_RTMP), `rtmp://203.0.113.10:10062/video/demo?key=${GOLDEN_KEY}`);
  });

  it('carries no key when the deployment checks none', () => {
    assert.equal(
      ingestUrl(config({ E2E_ENGINE: 'srs', E2E_PORT_SLOT: '2' }), INGEST_RTMP),
      'rtmp://203.0.113.10:10022/live/stream',
    );
  });

  it('dials the stock RTMP port when the deployment is unslotted', () => {
    assert.match(ingestUrl(config({ E2E_ENGINE: 'srs' }), INGEST_RTMP), /^rtmp:\/\/203\.0\.113\.10:1935\//);
  });

  it('presents a key a suite chose instead of the stream’s own, or none at all', () => {
    const cfg = config({ E2E_ENGINE: 'srs', E2E_STREAM_PATH: 'video/demo', PUBLISH_KEY_SECRET: GOLDEN_SECRET });

    assert.match(ingestUrl(cfg, INGEST_RTMP, cfg.streamPath, 'not-the-key'), /\/video\/demo\?key=not-the-key$/);
    assert.match(ingestUrl(cfg, INGEST_RTMP, cfg.streamPath, null), /\/video\/demo$/);
    assert.match(
      ingestUrl(cfg, INGEST_SRT, cfg.streamPath, 'not-the-key'),
      /streamid=#!::r=video\/demo\?key=not-the-key,m=publish$/,
    );
  });

  it('is the SRT URL it always was when SRT is asked for', () => {
    const cfg = config({ E2E_ENGINE: 'srs', E2E_PORT_SLOT: '2' });

    assert.equal(ingestUrl(cfg, INGEST_SRT), srtIngestUrl(cfg));
  });

  it('refuses RTMP against OME, which takes SRT only in this stack', () => {
    assert.throws(() => ingestUrl(config({ E2E_ENGINE: 'ome' }), INGEST_RTMP), /OME .* SRT only/);
  });

  /**
   * The ladder's rung lines, which the encoder hold suite reads: a rung SRS keeps through a drop sends neither, and a
   * rung it cut and restarted sends both.
   */
  /** The order a takeover produces, on a single stream and on a ladder's source, and never on a clean reconnect. */
  it('reads the old connection leaving after a newer one was accepted, for a single stream and for a source', () => {
    const single =
      '[SRS] Stream live/stream: a connection unpublished while another the hook accepted is still there, so ' +
      'nothing is disconnected';
    const source =
      '[SRS] Ladder source live/stream: a connection unpublished while another the hook accepted is still there, ' +
      'so the base stays';

    assert.equal(SRS_OLD_CONNECTION_LEFT_AFTER_A_NEWER.exec(single)?.[1], 'live/stream');
    assert.equal(SRS_OLD_CONNECTION_LEFT_AFTER_A_NEWER.exec(source)?.[1], 'live/stream');
    assert.equal(SRS_OLD_CONNECTION_LEFT_AFTER_A_NEWER.exec('[SRS] Stream unpublished: live/stream'), null);
  });

  /**
   * The uploader writes these lines as plain strings rather than through a shared composer, so this is what notices
   * a reword. A reader of a line nobody writes any more passes every absence it is asked to confirm.
   */
  it('reads lines the uploader’s SRS engine still writes, word for word', () => {
    const source = readFileSync(join(ROOT_DIR, 'packages', 'stream-uploader', 'src', 'engines', 'srs.ts'), 'utf8');

    for (const literal of [
      '[SRS] Rung published: ',
      '[SRS] Rung unpublished: ',
      '[SRS] Ladder source ',
      '[SRS] Stream ',
      ': a connection unpublished while another the hook accepted is still there',
    ]) {
      assert.ok(source.includes(literal), `the uploader's SRS engine no longer writes "${literal}"`);
    }
  });

  it('reads a rung’s published and unpublished lines, and not the source’s', () => {
    assert.equal(SRS_RUNG_PUBLISHED.exec('[SRS] Rung published: live/stream_720p')?.[1], 'live/stream_720p');
    assert.equal(SRS_RUNG_UNPUBLISHED.exec('[SRS] Rung unpublished: live/stream_360p')?.[1], 'live/stream_360p');
    assert.equal(SRS_RUNG_PUBLISHED.exec('[SRS] Ladder source authenticated: live/stream'), null);
    assert.equal(SRS_RUNG_UNPUBLISHED.exec('[SRS] Ladder source unpublished: live/stream'), null);
  });
});
