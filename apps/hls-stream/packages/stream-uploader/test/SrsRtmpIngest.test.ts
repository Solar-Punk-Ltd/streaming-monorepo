/**
 * An RTMP broadcaster, driven through the real SRS router with the hook bodies SRS 6 sends for one.
 *
 * Every broadcaster used to be told to use SRT, so the SRS cases elsewhere in this package send a minimal body.
 * RTMP is a public ingest now, and nothing in the engine is meant to branch on the protocol: one
 * `publishKeyFromParam` reads the key in either spelling, and the connections the hook accepted are told apart
 * by `client_id` alone. These cases hold the engine to that with the whole body, field for field, for an RTMP
 * publish and for an SRT one, so a field a later change starts to read is met here first.
 *
 * The bodies follow `SrsHttpHooks::on_publish` and `on_unpublish` in SRS 6.0-r2's
 * `trunk/src/app/srs_app_http_hooks.cpp`, which both protocols share. The fields that differ are filled the way
 * each connection fills its request. An RTMP `tcUrl` is the server URL the encoder connected with, and its
 * `param` keeps the `?` the stream key carries. An SRT `tcUrl` is built from SRS's own address with no port, and
 * its `param` comes out of the stream id without the `?` (`srs_srt_streamid_to_request` in
 * `srs_app_srt_utility.cpp`). Both connections resolve `vhost` against the config, so it reads
 * `__defaultVhost__` for either.
 */

import express from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSrsEngine } from '../src/engines/srs.js';
import { SRS_WEBHOOK_TOKEN_PARAM } from '../src/engines/srs/webhookToken.js';
import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import { AdminApiClient, AdminStreamDraft } from '../src/libs/AdminApiClient.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO } from '../src/types.js';
import { derivePublishKey, PUBLISH_KEY_PARAM } from '../src/utils/publishKey.js';

import { makeFakeOrchestrator, makeTestOrchestrator } from './helpers/fakes.js';
import { listenOnLoopback } from './helpers/loopbackServer.js';
import { waitFor } from './helpers/waiting.js';

const APP = 'video';
/** A topic as the admin mints one, which is the `<stream>` of a declared stream's ingest id. */
const STREAM = '5f0c7b9e-3a1d-4e8f-9b2c-6d4a1e7f0c3b';
const STREAM_ID = `${APP}/${STREAM}`;
const BROADCASTER = '203.0.113.10';
/** The engine's address as a broadcaster dials it, and the RTMP port of a stage at slot 6. */
const ENGINE_HOST = '203.0.113.5';
const RTMP_PORT = 10062;
const INGEST_VHOST = '__defaultVhost__';
const ABR_VHOST = 'abr';
const LOOPBACK_IP = '127.0.0.1';
const RUNG = '720p';

const SRS_TOKEN = 'srs-webhook-token-0123456789abcdef';
const PUBLISH_SECRET = 'publish-key-secret-0123456789abcdef';
const KEY = derivePublishKey(PUBLISH_SECRET, STREAM_ID);
const SETTLE_CEILING_MS = 4_000;

/** The longest the fork waits for the publisher a takeover replaces to go, before it refuses the new one. */
const FORK_TAKEOVER_WAIT_MS = 5_000;
/** Far past any takeover, so a connection still unsettled by then is one SRS refused. */
const PAST_ANY_TAKEOVER_MS = 60_000;

const RTMP = 'rtmp';
const SRT = 'srt';
type Protocol = typeof RTMP | typeof SRT;

const ON_PUBLISH = 'on_publish';
const ON_UNPUBLISH = 'on_unpublish';
type SrsStreamAction = typeof ON_PUBLISH | typeof ON_UNPUBLISH;

type SrsHookBody = Record<string, string>;

/** SRS's own ids for the server, the process and a stream in its statistics, which no handler reads. */
const SERVER_IDS = { server_id: 'vid-0xk989d', service_id: '2f5w51y2' };

interface BroadcasterHook {
  protocol: Protocol;
  action: SrsStreamAction;
  /** SRS's id for the connection, the same on its `on_publish` and on its `on_unpublish`. */
  clientId: string;
  /** The publish key the broadcaster put after the stream name. Omitted, the stream key carried none. */
  key?: string;
}

/** The body SRS 6 sends for a broadcaster's connection over `protocol`. */
function broadcasterHook({ protocol, action, clientId, key }: BroadcasterHook): SrsHookBody {
  const presented = key === undefined ? '' : `${PUBLISH_KEY_PARAM}=${key}`;
  return {
    ...SERVER_IDS,
    action,
    client_id: clientId,
    ip: BROADCASTER,
    vhost: INGEST_VHOST,
    app: APP,
    tcUrl: protocol === RTMP ? `rtmp://${ENGINE_HOST}:${RTMP_PORT}/${APP}` : `srt://${ENGINE_HOST}/${APP}`,
    stream: STREAM,
    param: presented !== '' && protocol === RTMP ? `?${presented}` : presented,
    stream_url: `/${APP}/${STREAM}`,
    stream_id: 'vid-1y2bq3l',
  };
}

/**
 * The body for a rung SRS's own encoder republishes over loopback RTMP onto the ABR vhost. The vhost travels in the
 * stream name's query, which SRS splits off into `param`, and a stream on a named vhost carries it in `stream_url`.
 */
function rungHook(action: SrsStreamAction): SrsHookBody {
  return {
    ...SERVER_IDS,
    action,
    client_id: 'k7r2m9q4',
    ip: LOOPBACK_IP,
    vhost: ABR_VHOST,
    app: APP,
    tcUrl: `rtmp://${LOOPBACK_IP}:${RTMP_PORT}/${APP}`,
    stream: `${STREAM}_${RUNG}`,
    param: `?vhost=${ABR_VHOST}`,
    stream_url: `${ABR_VHOST}/${APP}/${STREAM}_${RUNG}`,
    stream_id: 'vid-7k3m2pq',
  };
}

const rtmpPublish = (clientId: string, key?: string): SrsHookBody =>
  broadcasterHook({ protocol: RTMP, action: ON_PUBLISH, clientId, key });
const rtmpUnpublish = (clientId: string, key?: string): SrsHookBody =>
  broadcasterHook({ protocol: RTMP, action: ON_UNPUBLISH, clientId, key });
const srtPublish = (clientId: string, key?: string): SrsHookBody =>
  broadcasterHook({ protocol: SRT, action: ON_PUBLISH, clientId, key });
const srtUnpublish = (clientId: string, key?: string): SrsHookBody =>
  broadcasterHook({ protocol: SRT, action: ON_UNPUBLISH, clientId, key });

/** What SRS was answered: 0 lets the publish go on, anything else refuses it. */
async function sendHook(baseUrl: string, prefix: string, body: SrsHookBody): Promise<number> {
  const response = await fetch(`${baseUrl}${prefix}/streams?${SRS_WEBHOOK_TOKEN_PARAM}=${SRS_TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as number;
}

type Send = (body: SrsHookBody) => Promise<number>;

/** A real router in front of a real orchestrator, configured as `options` says. */
async function withEngine(
  options: Parameters<typeof createSrsEngine>[1],
  orchestrator: StreamOrchestrator,
  drive: (send: Send) => Promise<void>,
): Promise<void> {
  const engine = createSrsEngine('/srv/media', { webhookToken: SRS_TOKEN, ...options });
  const app = express();
  app.use(express.json());
  app.use(engine.prefix, engine.createRouter(orchestrator));
  const { server, baseUrl } = await listenOnLoopback(app);
  try {
    await drive((body) => sendHook(baseUrl, engine.prefix, body));
  } finally {
    server.close();
    await orchestrator.cleanup();
  }
}

describe('an RTMP publish meeting the derived publish key', () => {
  const withDerivedKeys = (drive: (send: Send, orchestrator: StreamOrchestrator) => Promise<void>): Promise<void> => {
    const orchestrator = makeTestOrchestrator();
    return withEngine({ publishKeySecret: PUBLISH_SECRET }, orchestrator, (send) => drive(send, orchestrator));
  };

  it('admits the stream key the admin hands a broadcaster, read out of the RTMP param', async () => {
    await withDerivedKeys(async (send, orchestrator) => {
      assert.equal(await send(rtmpPublish('p26w1s45', KEY)), 0);
      await waitFor(() => orchestrator.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
      assert.equal(orchestrator.getMetricsSnapshot().authRejectionsTotal, 0);
    });
  });

  it('refuses an RTMP publish carrying a wrong key, and counts it', async () => {
    await withDerivedKeys(async (send, orchestrator) => {
      assert.equal(await send(rtmpPublish('p26w1s45', derivePublishKey(PUBLISH_SECRET, `${APP}/another`))), 1);
      assert.equal(orchestrator.getActiveStreamCount(), 0);
      assert.equal(orchestrator.getMetricsSnapshot().authRejectionsTotal, 1);
    });
  });

  it('refuses an RTMP publish whose stream key carried no key at all', async () => {
    await withDerivedKeys(async (send, orchestrator) => {
      assert.equal(await send(rtmpPublish('p26w1s45')), 1);
      assert.equal(orchestrator.getActiveStreamCount(), 0);
      assert.equal(orchestrator.getMetricsSnapshot().authRejectionsTotal, 1);
    });
  });

  it('acts on the RTMP unpublish that repeats its publish’s key, holding the session for the encoder', async () => {
    await withDerivedKeys(async (send, orchestrator) => {
      assert.equal(await send(rtmpPublish('p26w1s45', KEY)), 0);
      await waitFor(() => orchestrator.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
      orchestrator.handleSegment(STREAM_ID, 0, 2, Buffer.from('segment'));

      assert.equal(await send(rtmpUnpublish('p26w1s45', KEY)), 0);
      await waitFor(() => orchestrator.getHealthSignals().disconnectedStreams.length === 1, SETTLE_CEILING_MS);
      assert.deepEqual(orchestrator.getHealthSignals().disconnectedStreams, [STREAM_ID]);
      assert.equal(orchestrator.getActiveStreamCount(), 1, 'the session is held for the reconnect window');
    });
  });
});

describe('an RTMP publish meeting the admin publish gate', () => {
  const FEED_OWNER = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const DECLARED_KEY = 'declared-publish-key-0123456789';
  const DRAFT: AdminStreamDraft = {
    id: 'str_01HZY',
    topic: STREAM,
    owner: FEED_OWNER,
    mediaType: MEDIA_TYPE_VIDEO,
    title: 'A declared broadcast',
    status: 'draft',
    publishKey: DECLARED_KEY,
  };

  /** An admin whose lookup answers the draft above and whose state reports always succeed. */
  function adminAnsweringTheDraft(): AdminApiClient {
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'POST'
        ? new Response('{}', { status: 200 })
        : new Response(JSON.stringify(DRAFT), { status: 200 })) as typeof globalThis.fetch;
    return new AdminApiClient({
      baseUrl: 'http://admin.test:9877',
      token: 'admin-api-token-0123456789abcdef',
      fetcher,
    });
  }

  const withAdmin = (drive: (send: Send, orchestrator: StreamOrchestrator) => Promise<void>): Promise<void> => {
    const adminApi = adminAnsweringTheDraft();
    const orchestrator = makeTestOrchestrator({ adminApi });
    return withEngine({ adminApi, signerOwner: `0x${FEED_OWNER}` }, orchestrator, (send) => drive(send, orchestrator));
  };

  it('admits the key the declaration carries, read out of the RTMP param', async () => {
    await withAdmin(async (send, orchestrator) => {
      assert.equal(await send(rtmpPublish('p26w1s45', DECLARED_KEY)), 0);
      await waitFor(() => orchestrator.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
      assert.equal(orchestrator.getMetricsSnapshot().authRejectionsTotal, 0);
    });
  });

  it('refuses an RTMP publish carrying a key the declaration does not', async () => {
    await withAdmin(async (send, orchestrator) => {
      assert.equal(await send(rtmpPublish('p26w1s45', 'not-the-declared-key')), 1);
      assert.equal(orchestrator.getActiveStreamCount(), 0);
      assert.equal(orchestrator.getMetricsSnapshot().authRejectionsTotal, 1);
    });
  });
});

/** Which orchestrator calls a sequence of hooks made, each placed by the index of the hook that made it. */
interface OrchestratorCalls {
  started: string[];
  /** Per `startStream`, whether the engine held its resume back until an older connection leaves. */
  startDeferred: boolean[];
  disconnectedAt: number[];
  deferredResumedAt: number[];
  deferredDroppedAt: number[];
  /** Each hook that asked a ladder source's held rungs to resume. */
  heldRungsResumedAt: number[];
}

interface TimedHook {
  body: SrsHookBody;
  /** The engine's clock when the hook arrives, in ms from the case's start. Stepped, never waited for. */
  atMs?: number;
  /** What SRS must be answered, 0 unless the case expects a refusal. */
  answer?: number;
}

/** Sends `hooks` in order to a router in derived-key mode, in front of an orchestrator that only records. */
async function callsMadeBy(
  hooks: readonly TimedHook[],
  options: { ladder?: boolean } = {},
): Promise<OrchestratorCalls> {
  const calls: OrchestratorCalls = {
    started: [],
    startDeferred: [],
    disconnectedAt: [],
    deferredResumedAt: [],
    deferredDroppedAt: [],
    heldRungsResumedAt: [],
  };
  let hookAt = 0;
  let nowMs = 0;
  const orchestrator = makeFakeOrchestrator({
    startStream: (
      streamId: string,
      _mediatype: unknown,
      _claimant: unknown,
      _admin: unknown,
      startOptions?: { deferResume?: boolean },
    ) => {
      calls.started.push(streamId);
      calls.startDeferred.push(startOptions?.deferResume ?? false);
      return true;
    },
    noteDisconnect: () => calls.disconnectedAt.push(hookAt),
    resumeDeferredReturn: () => calls.deferredResumedAt.push(hookAt),
    dropDeferredReturn: () => calls.deferredDroppedAt.push(hookAt),
    resumeHeldRungs: () => calls.heldRungsResumedAt.push(hookAt),
    cleanup: async () => {},
  });

  await withEngine(
    {
      publishKeySecret: PUBLISH_SECRET,
      clock: () => nowMs,
      ...(options.ladder ? { abr: { vhost: ABR_VHOST, ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC) } } : {}),
    },
    orchestrator,
    async (send) => {
      for (const [at, { body, atMs, answer = 0 }] of hooks.entries()) {
        hookAt = at;
        nowMs = atMs ?? nowMs;
        assert.equal(await send(body), answer, `SRS must be answered ${answer} for hook ${at}, ${body.action}`);
      }
    },
  );
  return calls;
}

/**
 * An RTMP takeover, in the order the fork sends its hooks: the new connection's `on_publish`, then the old
 * connection's `on_unpublish` once SRS has expired it, then the new connection's media with no second publish.
 * The old connection's unpublish arrives after the new one was accepted, so acting on it would report a live
 * stream as disconnected, or clear a live ladder's base and refuse every rung after it.
 */
describe('the hooks an RTMP takeover sends', () => {
  it('admits the new connection and does not act on the old one’s late unpublish, on a single stream', async () => {
    const calls = await callsMadeBy([
      { body: rtmpPublish('old0conn', KEY) },
      { body: rtmpPublish('new0conn', KEY) },
      { body: rtmpUnpublish('old0conn', KEY) },
    ]);

    assert.deepEqual(calls.started, [STREAM_ID, STREAM_ID], 'the takeover is announced as a return');
    assert.deepEqual(calls.startDeferred, [false, true], 'whose resume waits for the connection it replaces');
    assert.deepEqual(calls.deferredResumedAt, [2], 'and goes ahead when that connection leaves');
    assert.deepEqual(calls.disconnectedAt, [], 'the stream still has its publisher');
  });

  it('keeps a ladder source’s base through the old connection’s late unpublish, and resumes its held rungs then', async () => {
    const calls = await callsMadeBy(
      [
        { body: rtmpPublish('old0conn', KEY) },
        { body: rtmpPublish('new0conn', KEY) },
        { body: rtmpUnpublish('old0conn', KEY) },
        { body: rungHook(ON_PUBLISH) },
      ],
      { ladder: true },
    );

    assert.deepEqual(calls.started, [`${STREAM_ID}_${RUNG}`], 'a rung of the new connection is admitted');
    assert.deepEqual(calls.heldRungsResumedAt, [0, 2], 'the first publish, then the takeover as the old one leaves');
  });

  /**
   * The fork waits up to five seconds for the old publisher to go, and the old connection's unpublish arrives
   * inside that wait. The uploader forgets an unsettled connection only after `TAKEOVER_SETTLE_MS`, ten seconds,
   * so a takeover that uses the whole wait is still read as one.
   */
  it('still reads a takeover whose old connection took the fork’s whole wait to leave', async () => {
    const calls = await callsMadeBy([
      { body: rtmpPublish('old0conn', KEY), atMs: 0 },
      { body: rtmpPublish('new0conn', KEY), atMs: 0 },
      { body: rtmpUnpublish('old0conn', KEY), atMs: FORK_TAKEOVER_WAIT_MS },
    ]);

    assert.deepEqual(calls.deferredResumedAt, [2]);
    assert.deepEqual(calls.disconnectedAt, []);
  });

  /**
   * SRS refuses an RTMP reconnect as busy when the takeover is off, or when the old publisher does not go within
   * the wait, and RTMP sends no `on_unpublish` for a connection it refused. That connection never says it left,
   * so the uploader forgets it once it has gone unsettled for ten seconds, and the live publisher's own exit acts.
   */
  it('notes the disconnect when the live connection leaves long after SRS refused an RTMP reconnect in silence', async () => {
    const calls = await callsMadeBy([
      { body: rtmpPublish('live0conn', KEY), atMs: 0 },
      { body: rtmpPublish('refused0', KEY), atMs: 0 },
      { body: rtmpUnpublish('live0conn', KEY), atMs: PAST_ANY_TAKEOVER_MS },
    ]);

    assert.deepEqual(calls.deferredDroppedAt, [2], 'the refused reconnect resumes nothing');
    assert.deepEqual(calls.disconnectedAt, [2], 'and the connection that really left is reported gone');
  });

  it('forgets a ladder source’s base when the live connection leaves long after a silent RTMP refusal', async () => {
    const calls = await callsMadeBy(
      [
        { body: rtmpPublish('live0conn', KEY), atMs: 0 },
        { body: rtmpPublish('refused0', KEY), atMs: 0 },
        { body: rtmpUnpublish('live0conn', KEY), atMs: PAST_ANY_TAKEOVER_MS },
        { body: rungHook(ON_PUBLISH), answer: 1 },
      ],
      { ladder: true },
    );

    assert.deepEqual(calls.started, [], 'its rungs must not outlive the source that really left');
  });
});

/**
 * A broadcaster moving from one protocol to the other without ending the broadcast, which SRS handles as a
 * takeover: the new protocol's takeover decides it, and the connection it replaces can be either. Each old
 * connection's late unpublish carries the key in its own protocol's spelling, and has to pass the key check in
 * that spelling, or the resume held for the new connection would never go ahead.
 */
describe('a broadcaster switching protocol in the middle of a broadcast', () => {
  it('reads an SRT connection replaced by an RTMP one as a takeover, and the RTMP one leaving as the end', async () => {
    const calls = await callsMadeBy([
      { body: srtPublish('srt0conn', KEY) },
      { body: rtmpPublish('rtmp0conn', KEY) },
      { body: srtUnpublish('srt0conn', KEY) },
      { body: rtmpUnpublish('rtmp0conn', KEY) },
    ]);

    assert.deepEqual(calls.startDeferred, [false, true]);
    assert.deepEqual(calls.deferredResumedAt, [2], 'the SRT connection’s unpublish passed the key check');
    assert.deepEqual(calls.disconnectedAt, [3], 'only the RTMP connection leaving disconnects the stream');
  });

  it('reads an RTMP connection replaced by an SRT one as a takeover, and the SRT one leaving as the end', async () => {
    const calls = await callsMadeBy([
      { body: rtmpPublish('rtmp0conn', KEY) },
      { body: srtPublish('srt0conn', KEY) },
      { body: rtmpUnpublish('rtmp0conn', KEY) },
      { body: srtUnpublish('srt0conn', KEY) },
    ]);

    assert.deepEqual(calls.startDeferred, [false, true]);
    assert.deepEqual(calls.deferredResumedAt, [2], 'the RTMP connection’s unpublish passed the key check');
    assert.deepEqual(calls.disconnectedAt, [3], 'only the SRT connection leaving disconnects the stream');
  });

  it('keeps a ladder source’s base when its broadcaster switches from SRT to RTMP', async () => {
    const calls = await callsMadeBy(
      [
        { body: srtPublish('srt0conn', KEY) },
        { body: rtmpPublish('rtmp0conn', KEY) },
        { body: srtUnpublish('srt0conn', KEY) },
        { body: rungHook(ON_PUBLISH) },
      ],
      { ladder: true },
    );

    assert.deepEqual(calls.started, [`${STREAM_ID}_${RUNG}`]);
    assert.deepEqual(calls.heldRungsResumedAt, [0, 2]);
  });

  it('keeps a ladder source’s base when its broadcaster switches from RTMP to SRT', async () => {
    const calls = await callsMadeBy(
      [
        { body: rtmpPublish('rtmp0conn', KEY) },
        { body: srtPublish('srt0conn', KEY) },
        { body: rtmpUnpublish('rtmp0conn', KEY) },
        { body: rungHook(ON_PUBLISH) },
      ],
      { ladder: true },
    );

    assert.deepEqual(calls.started, [`${STREAM_ID}_${RUNG}`]);
    assert.deepEqual(calls.heldRungsResumedAt, [0, 2]);
  });
});
