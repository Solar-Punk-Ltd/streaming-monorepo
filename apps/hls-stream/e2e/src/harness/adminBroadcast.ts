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
import { fragmentSecondsFor, type RungFeed } from './manifestContractLive.js';
import { readRecordingListing } from './recordingListing.js';
import { startPublisherAt } from './publisher.js';
import { vodFinalizeWaitMs } from './recording.js';
import {
  checkRungPlaylistsLive,
  type RungPublishingVerdict,
  topicResumes,
  type TopicResume,
} from './rungPublishing.js';
import { recoveryEntryIds, readRecoveryEntry } from './uploaderState.js';
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

/** How far back into the uploader's log to look for a declared stream's earlier rung announces. */
const PRIOR_ANNOUNCE_TAIL_LINES = 50_000;

/** What a declared stream's feeds already hold before a suite broadcasts on it. */
export interface PriorRecording {
  /** Sessions each rung's recording already glues, 0 for a rung with no recording yet. */
  sessionsByRung: ReadonlyMap<string, number>;
}

/**
 * The sessions a declared stream's recordings already hold, so a suite counts its own sessions on top of them.
 *
 * A declared stream is reused across runs, and every recording on it glues every session its feed ever carried, so a
 * session count asserted without this baseline is only right on the first run ever made on that stream.
 */
export async function priorRecording(host: Host, cfg: E2EConfig, declared: DeclaredStream): Promise<PriorRecording> {
  const feeds = await declaredRungFeeds(host, cfg, declared);
  if (feeds.length === 0) {
    return { sessionsByRung: new Map() };
  }
  const listing = await readRecordingListing(host, cfg, { owner: declared.stream.owner, ladder: null, feeds });
  return {
    sessionsByRung: new Map(listing.rungs.map((rung) => [rung.rung, rung.recording ? rung.sessions : 0])),
  };
}

/**
 * Every rung feed a declared stream has announced, newest per rung, out of the uploader's log rather than a suite's
 * own window: a suite reading a recording made by an earlier suite or an earlier run has no window of its own.
 * Empty where the log no longer reaches back to any broadcast on it.
 */
export async function declaredRungFeeds(host: Host, cfg: E2EConfig, declared: DeclaredStream): Promise<RungFeed[]> {
  const streamPath = declaredStreamPath(declared.stream);
  const tail = await host.logs(containerName(cfg, 'stream-uploader'), PRIOR_ANNOUNCE_TAIL_LINES);
  const newestPerRung = new Map<string, RungFeed>();
  for (const announce of announcedRungs(tail).filter((line) => line.streamId.startsWith(streamPath))) {
    newestPerRung.set(announce.rung, { rung: announce.rung, streamId: announce.streamId, topic: announce.topic });
  }
  return [...newestPerRung.values()];
}
