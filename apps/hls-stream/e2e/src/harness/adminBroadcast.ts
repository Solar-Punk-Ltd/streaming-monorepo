/**
 * One broadcast on a declared admin stream, start to finalize, the way OBS and the operator would make it.
 *
 * The admin suites make several broadcasts on one declared stream and judge each one the same way, so the session is
 * one function: publish the stream to the catalogue if it is a draft, broadcast to the ingest the admin hands out, hold
 * every rung to live playlists for the session, stop, and wait for the uploader to finalize and the admin row to say
 * `vod`. Each session hands back its own log window and the facts a later session is compared against.
 *
 * ⛔ A declared stream already `live` is refused rather than broadcast to. That is another broadcaster on the same key,
 * and two sessions on one topic is a fault this harness must never be the cause of.
 */

import { containerName, type E2EConfig } from '../config.js';

import { AdminApi, type AdminStream, adminIngestTarget, declaredStreamPath } from './adminApi.js';
import type { Host } from './host.js';
import { announcedRungs, segmentIndicesByStream, vodFinalizeCountFor } from './logwatch.js';
import { fragmentSecondsFor, type RungFeed, rungFeedsOf } from './manifestContractLive.js';
import { type RecordingListing, waitForRecordingListing } from './recordingListing.js';
import { startPublisherAt } from './publisher.js';
import { vodFinalizeWaitMs } from './recording.js';
import {
  checkRungPlaylistsLive,
  headProbeCorrections,
  type RungPublishingVerdict,
  topicResumes,
  type TopicResume,
} from './rungPublishing.js';
import { recoveryEntryIds, readRecoveryEntry } from './uploaderState.js';
import { fetchCatalog } from './viewer.js';
import { sleep, waitFor } from './wait.js';

/** The declared stream as a broadcaster sees it: its row, and where its ingest is. */
export interface DeclaredStream {
  stream: AdminStream;
  url: string;
  protocol: 'srt' | 'rtmp';
}

/**
 * The declared stream ready to take a broadcast: on the catalogue, and with an ingest to send to.
 *
 * A draft is published first, because the uploader refuses a broadcast to a stream the admin has not published.
 */
export async function prepareDeclaredStream(api: AdminApi, streamId: string): Promise<DeclaredStream> {
  let stream = await api.getStream(streamId);
  if (stream.status === 'live') {
    throw new Error(
      `declared stream ${streamId} is already live, so another broadcaster holds its key. Stop that broadcast first`,
    );
  }
  if (stream.status === 'draft') {
    stream = (await api.publish(streamId)).stream;
  }
  const target = adminIngestTarget(await api.ingest(streamId));
  if (target === null) {
    throw new Error(`declared stream ${streamId} has no stage, so the admin hands out nowhere to broadcast it`);
  }
  return { stream, ...target };
}

/** How one session is run and what it must show. */
interface SessionPlan {
  declared: DeclaredStream;
  /** Seconds of broadcast from the first segment to the stop. */
  seconds: number;
  /** Live playlists every rung must publish, within {@link publishWithinMs} of the first segment. */
  minPublishes: number;
  publishWithinMs: number;
  headWaitMs: number;
  /** Anything a suite does to the admin while the broadcast is live, after the playlists were judged. */
  whileLive?: () => Promise<void>;
}

/** What one session did, for its own verdicts and for the next session's. */
export interface SessionRecord {
  startedAt: string;
  stoppedAt: string;
  /** The uploader log from the publisher's start to the finalize. */
  log: string;
  /** The live-playlist verdict taken while it ran. */
  playlists: RungPublishingVerdict;
  /** Every resume line this session wrote, one per rung that reopened the declared topic. */
  resumes: readonly TopicResume[];
  /** The ladder group the rungs announced, which is the master feed's topic. */
  ladder: string | null;
  /** The size in bytes of each recovery entry held while it was live, keyed by entry id. */
  recoveryEntryBytes: ReadonlyMap<string, number>;
}

const FIRST_SEGMENT_WAIT_MS = 120_000;
const ADMIN_VOD_WAIT_MS = 300_000;

/**
 * One broadcast on the declared stream, judged while it runs and finished before it returns.
 *
 * ⛔ Never throws on the playlists: the verdict is handed back for the suite to assert, so a session that published
 * badly still stops and finalizes and the next session is not run into a stage left live.
 */
export async function broadcastSession(
  host: Host,
  cfg: E2EConfig,
  api: AdminApi,
  { declared, seconds, minPublishes, publishWithinMs, headWaitMs, whileLive }: SessionPlan,
): Promise<SessionRecord> {
  const uploader = containerName(cfg, 'stream-uploader');
  const streamPath = declaredStreamPath(declared.stream);
  const startedAt = await host.nowIso();
  const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
  const publisher = startPublisherAt(declared.url, declared.protocol);
  const ownStreams = (text: string): string[] =>
    [...segmentIndicesByStream(text).keys()].filter((streamId) => streamId.startsWith(streamPath));

  let stoppedAt: string;
  let playlists: RungPublishingVerdict;
  const recoveryEntryBytes = new Map<string, number>();
  try {
    await waitFor(async () => ownStreams(await log()).length > 0, {
      timeoutMs: FIRST_SEGMENT_WAIT_MS,
      intervalMs: 2_000,
      label: `the first segment of ${streamPath} uploads`,
    });
    const firstSegmentAtMs = Date.now();

    playlists = await checkRungPlaylistsLive(host, cfg, {
      log,
      rungs: cfg.abrEnabled ? cfg.abrRungs : null,
      minPublishes,
      publishWaitMs: publishWithinMs,
      headWaitMs,
      owner: declared.stream.owner,
    });

    await whileLive?.();
    for (const id of await recoveryEntryIds(host, cfg)) {
      recoveryEntryBytes.set(id, Buffer.byteLength(await readRecoveryEntry(host, cfg, id), 'utf8'));
    }

    await sleep(Math.max(0, seconds * 1_000 - (Date.now() - firstSegmentAtMs)));
  } finally {
    stoppedAt = await host.nowIso();
    await publisher.stop();
  }

  const topics = [...new Set(announcedRungs(await log()).map((announce) => announce.topic))];
  await waitFor(async () => vodFinalizeCountFor(await log(), topics) >= 1, {
    timeoutMs: vodFinalizeWaitMs({ segmentSeconds: fragmentSecondsFor(cfg.segmentExpectation), pollMs: 3_000 }),
    intervalMs: 3_000,
    label: `the session on ${streamPath} finalizes to VOD after the stop`,
  });
  await waitFor(async () => (await api.getStream(declared.stream.id)).status === 'vod', {
    timeoutMs: ADMIN_VOD_WAIT_MS,
    intervalMs: 3_000,
    label: `the admin row of ${declared.stream.id} says vod`,
  });

  const text = await log();
  return {
    startedAt,
    stoppedAt,
    log: text,
    playlists,
    resumes: topicResumes(text),
    ladder: announcedRungs(text)[0]?.ladder ?? null,
    recoveryEntryBytes,
  };
}

/** One observation line per session, never asserted: what the uploader had to correct or hold while it ran. */
export function sessionObservations(session: SessionRecord): string {
  return (
    `  observations, none of them asserted. the uploader corrected bee's feed head answer ` +
    `${headProbeCorrections(session.log).length} time(s) in this session`
  );
}

/** How long a finished session's recording is given to land on every rung. */
const RECORDING_AFTER_SESSION_WAIT_MS = 180_000;

/**
 * The recording on every rung once a session finalized, read from that session's own feeds.
 *
 * ⛔ Its own log window and nothing older, so it holds after a redeploy that emptied every earlier log. A suite takes
 * one after its first session as the baseline and one after its last, and `sessionGrowthRefusal` judges the
 * difference, because the recording on a declared stream glues every session its feed ever carried.
 */
export async function recordingAfter(
  host: Host,
  cfg: E2EConfig,
  declared: DeclaredStream,
  session: SessionRecord,
): Promise<RecordingListing> {
  return waitForRecordingListing(
    host,
    cfg,
    { owner: declared.stream.owner, ladder: session.ladder, feeds: rungFeedsOf(session.log) },
    RECORDING_AFTER_SESSION_WAIT_MS,
  );
}

/**
 * Every rung feed of a declared stream, out of its catalogue entry rather than any log: a suite reading a recording an
 * earlier suite or an earlier run made has no window of its own, and a redeploy empties the log anyway. The catalogue
 * is where the admin says it is, `GET /api/config`, read through the gateway the way a viewer reads it. Empty where the
 * entry names no renditions, which is a stream with no finished ladder on the catalogue.
 */
export async function declaredRungFeeds(
  host: Host,
  cfg: E2EConfig,
  api: AdminApi,
  declared: DeclaredStream,
): Promise<RungFeed[]> {
  const { feed } = await api.config();
  const entry = (await fetchCatalog(host, cfg, { owner: feed.owner, topicHex: feed.topicHex })).find(
    (candidate) => candidate.topic === declared.stream.topic,
  );
  return (entry?.renditions ?? []).map((rendition) => ({
    rung: rendition.name,
    streamId: null,
    topic: rendition.topic,
  }));
}
