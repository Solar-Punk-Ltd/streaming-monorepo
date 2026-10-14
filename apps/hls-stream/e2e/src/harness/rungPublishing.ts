/**
 * Whether every rung keeps a live playlist a viewer can follow, read two ways: the uploader saying it published one,
 * and the gateway serving one that moved.
 *
 * ## ⛔ Why segments are not enough
 *
 * On 2026-10-14 a re-broadcast on one declared stream left two or three of its four rungs with no live playlist at all,
 * and every suite here passed. Each rung kept uploading segments, so every per-rung check that counted segments or
 * announced rungs saw a healthy ladder. What had stopped was the manifest publish: the rung's feed head never moved
 * past the previous broadcast's last playlist, and the uploader said so on every segment with a stale warning nobody
 * read. A segment nobody's playlist names is media no viewer can reach.
 *
 * So three readings live here, and a healthy ladder suite asks all three of every rung:
 *
 * - **H1, the publishes.** `Manifest of <stream> uploaded at SOC index N`, counted per rung, and the uploader's own
 *   `Live manifest for stream X is stale: N consecutive publish failure(s)`, which must not appear at all on a
 *   broadcast with no fault in it.
 * - **H2, the head.** Each rung's feed read off the gateway twice, a few segments apart. Its last sequence, which is
 *   the media sequence plus the entries the window holds, must have moved on every rung. A rung whose head stands still
 *   is what a joining viewer sees as a broadcast that froze, whatever the log says.
 * - The resume line, `Stream X resumes its topic at SOC index N`, which a session reusing a topic writes once when it
 *   reads the head it continues from. A reused topic with no such line is a session that numbered itself from nothing.
 *
 * ⚠️ The stale, resume and recovery lines are raw text rather than composers in the shared package, because adding a
 * composer would change the uploader and this harness is not where that change belongs. `src/logLevel.ts` pins each
 * fragment against the uploader's own source, so a reword fails `pnpm test` here rather than reading as silence.
 *
 * The parse and the verdicts are pure so `test/rungPublishing.test.ts` covers them under `pnpm verify`, which nothing
 * under `suites/` is. {@link readRungHeads}, {@link waitForRungHeadsAdvance} and {@link checkRungPlaylistsLive} are the
 * only wiring.
 */

import { feedTopicHexOf } from '../browser/rungManifest.js';
import type { E2EConfig } from '../config.js';

import type { Host } from './host.js';
import { announcedRungs, manifestIndicesByStream, messageText, segmentIndicesByStream } from './logwatch.js';
import { type RungFeed, type RungPlaylistParse, readOneRungPlaylist, rungFeedsOf } from './manifestContractLive.js';
import { counterOf, rungCountersOf } from './uploaderMetrics.js';
import { discoverCatalogFeed } from './viewer.js';
import { sleep, waitFor } from './wait.js';

/** `live/stream_1080p` and its rung name, out of the rung announces. Absent on a single rendition. */
function rungByStreamId(logText: string): ReadonlyMap<string, string> {
  return new Map(announcedRungs(logText).map((announce) => [announce.streamId, announce.rung]));
}

/** Per-stream counts keyed by rung name where the stream is a rung, else by its stream id. */
function byRungName(logText: string, byStream: ReadonlyMap<string, readonly number[]>): Map<string, number> {
  const rungOf = rungByStreamId(logText);
  const counts = new Map<string, number>();
  for (const [streamId, indices] of byStream) {
    const key = rungOf.get(streamId) ?? streamId;
    counts.set(key, (counts.get(key) ?? 0) + indices.length);
  }
  return counts;
}

/**
 * Live manifest publishes per rung in this log window, keyed by rung name, or by stream id on a single rendition.
 *
 * ⛔ Not deduplicated. A publish is one feed write, so a rung that published the same SOC index twice has written
 * twice, and that is a different defect from never publishing, which a set would hide. Contiguity is
 * `isContiguous`'s question and `service/happy-path` asks it.
 */
export function manifestPublishesByRung(logText: string): ReadonlyMap<string, number> {
  return byRungName(logText, manifestIndicesByStream(logText));
}

/** Segment uploads per rung, keyed the way {@link manifestPublishesByRung} keys publishes so the two pair by label. */
export function segmentUploadsByRung(logText: string): ReadonlyMap<string, number> {
  return byRungName(logText, segmentIndicesByStream(logText));
}

/**
 * Which of the expected rungs published fewer than `atLeast` live manifests, as a sentence, or null.
 *
 * ⛔ An empty expectation refuses. Every rung of nothing has published at least n, so a caller that could not work out
 * its rungs would otherwise pass on a broadcast that published nothing at all.
 */
export function publishShortfall(
  publishes: ReadonlyMap<string, number>,
  expected: readonly string[],
  atLeast: number,
): string | null {
  if (expected.length === 0) {
    return 'no rung was expected to publish, so a playlist count was never taken. The caller could not name its rungs';
  }
  const short = expected.filter((rung) => (publishes.get(rung) ?? 0) < atLeast);
  if (short.length === 0) {
    return null;
  }
  const counts = expected.map((rung) => `${rung} ${publishes.get(rung) ?? 0}`).join(', ');
  return (
    `${short.join(', ')} published fewer than ${atLeast} live playlist(s) (${counts}). A rung that uploads segments ` +
    'and publishes no playlist naming them is media no viewer can reach, which is the 2026-10-14 re-broadcast defect'
  );
}

/** Whether every expected rung published at least `atLeast` live manifests in this window. */
export function everyRungPublishedAtLeast(logText: string, expected: readonly string[], atLeast: number): boolean {
  return publishShortfall(manifestPublishesByRung(logText), expected, atLeast) === null;
}

/** One stale warning: which stream's live playlist failed to publish, and how many times in a row by then. */
interface StaleManifestWarning {
  streamId: string;
  consecutive: number;
}

const STALE_LINE = /Live manifest for stream (\S+) is stale: (\d+) consecutive publish failure\(s\)/g;

/** Every stale-playlist warning in the window, in the order the uploader wrote them. */
export function staleManifestWarnings(logText: string): StaleManifestWarning[] {
  return [...messageText(logText).matchAll(STALE_LINE)].map((match) => ({
    streamId: match[1],
    consecutive: Number(match[2]),
  }));
}

const HELD_LINE = /Live manifest for stream (\S+) is held: its feed position is not settled yet \((\d+) consecutive\)/g;

/**
 * Every held-publish notice in the window: a live playlist the uploader would not write yet because where its feed
 * stands is not settled, which is a session waiting for the one it replaced to finish draining onto the same topic.
 *
 * ⛔ Counted as an observation only, never as a stale warning. A hold is the uploader refusing on purpose and saying so
 * in its own words, and {@link staleManifestWarnings} does not match it. The line arrives with the uploader change that
 * stops counting a hold as a publish failure, so on an older uploader a hold still reads as stale and this reads none.
 */
export function heldManifestNotices(logText: string): StaleManifestWarning[] {
  return [...messageText(logText).matchAll(HELD_LINE)].map((match) => ({
    streamId: match[1],
    consecutive: Number(match[2]),
  }));
}

/**
 * Why the stale warnings in a window mean a healthy broadcast was not, or null when there were none.
 *
 * ⛔ Any at all refuses, on a broadcast with no fault in it. One failed publish is retried at the next segment and the
 * warning is how the uploader says a viewer's playlist fell behind for that long. A suite that injects a fault reads
 * its own window and does not call this over the fault.
 */
export function staleWarningRefusal(warnings: readonly StaleManifestWarning[]): string | null {
  if (warnings.length === 0) {
    return null;
  }
  const worst = new Map<string, number>();
  for (const warning of warnings) {
    worst.set(warning.streamId, Math.max(worst.get(warning.streamId) ?? 0, warning.consecutive));
  }
  const detail = [...worst].map(([streamId, run]) => `${streamId} up to ${run} in a row`).join(', ');
  return (
    `the uploader warned ${warnings.length} time(s) that a live playlist was stale: ${detail}. Each warning is a ` +
    'manifest publish that failed while segments kept uploading, so a viewer on that rung was handed an old playlist'
  );
}

/** One session reading the head of a topic it continues: where its SOC writes resume and its numbering carries on. */
export interface TopicResume {
  streamId: string;
  socIndex: number;
  mediaSequence: number;
}

const RESUME_LINE =
  /Stream (\S+) resumes its topic at SOC index (\d+), numbering its playlist from media sequence (\d+)/g;

/** Every resume line in the window, in order. */
export function topicResumes(logText: string): TopicResume[] {
  return [...messageText(logText).matchAll(RESUME_LINE)].map((match) => ({
    streamId: match[1],
    socIndex: Number(match[2]),
    mediaSequence: Number(match[3]),
  }));
}

const RECOVERED_LINE = /Recovered stream (\S+) with \d+ segments/g;

/**
 * Streams rebuilt from a recovery entry after a crash, which continue from the index they had on disk and so never
 * read the feed head and never write a resume line. See `topicOutlivesThisSession` in the uploader.
 */
export function crashRecoveredStreams(logText: string): string[] {
  return [...new Set([...messageText(logText).matchAll(RECOVERED_LINE)].map((match) => match[1]))];
}

/** One head-probe correction: bee answered one index as a feed's head and the uploader found playlists above it. */
interface HeadProbeCorrection {
  streamId: string;
  answered: number;
  present: number;
}

const HEAD_PROBE_LINE =
  /bee answered SOC index (\d+) as the head of (\S+)'s feed, but the feed holds playlists up to (\d+)/g;

/**
 * Every time the uploader found bee's answer for a feed's head below the playlists actually on it, and continued from
 * the highest one instead. Read as an observation: the correction is the uploader working, and how often bee needs it
 * is a fact about the node rather than a fault here.
 *
 * ⚠️ The line arrives with the head-probe fix on its own branch, so on a stage without it this always reads none, and
 * `src/logLevel.ts` cannot pin it against this checkout's uploader yet.
 */
export function headProbeCorrections(logText: string): HeadProbeCorrection[] {
  return [...messageText(logText).matchAll(HEAD_PROBE_LINE)].map((match) => ({
    streamId: match[2],
    answered: Number(match[1]),
    present: Number(match[3]),
  }));
}

const REAPED_AFTER_DISCONNECT_LINE = /The encoder feeding (\S+) left and did not come back within the/g;

/**
 * Streams whose reconnect window ran out after their encoder left, which is the moment their session starts to drain
 * into a recording. On SRS this is how every ordinary broadcast ends, see `logReap` in the uploader.
 */
export function reapedAfterDisconnect(logText: string): string[] {
  return [...new Set([...messageText(logText).matchAll(REAPED_AFTER_DISCONNECT_LINE)].map((match) => match[1]))];
}

/**
 * The rungs that opened a session on a topic an earlier session had announced and wrote no resume line for it.
 *
 * ⛔ Such a session numbered its playlist and its SOC writes from nothing on a feed that already holds playlists, which
 * writes over the earlier ones, or is refused as a stale index forever. A session rebuilt from a recovery entry is left
 * out, because it continues from disk and is right not to read the head.
 *
 * @param before the log of the earlier session, whose announces say which topics already carry a feed
 * @param after the log from the restart on
 */
export function missingTopicResumes(before: string, after: string): string[] {
  const earlierTopics = new Set(announcedRungs(before).map((announce) => announce.topic));
  const recovered = new Set(crashRecoveredStreams(after));
  const resumed = new Set(topicResumes(after).map((resume) => resume.streamId));
  const missing = new Set<string>();
  for (const announce of announcedRungs(after)) {
    if (earlierTopics.has(announce.topic) && !recovered.has(announce.streamId) && !resumed.has(announce.streamId)) {
      missing.add(announce.rung);
    }
  }
  return [...missing];
}

/** Every rung's live manifest SOC indices in publish order, keyed the way {@link manifestPublishesByRung} keys counts. */
export function manifestIndicesByRung(logText: string): ReadonlyMap<string, readonly number[]> {
  const rungOf = rungByStreamId(logText);
  const byRung = new Map<string, number[]>();
  for (const [streamId, indices] of manifestIndicesByStream(logText)) {
    const key = rungOf.get(streamId) ?? streamId;
    byRung.set(key, [...(byRung.get(key) ?? []), ...indices]);
  }
  return byRung;
}

/**
 * Which rungs published a live manifest after a restart at an SOC index that does not continue the feed, or null.
 *
 * ⛔ Every index after has to be above the highest index before, and none may be 0. A feed lookup resolves the
 * highest index it finds, so a session that writes at or below its predecessor's head has written a playlist no viewer
 * will ever be handed, and index 0 is the previous recording's opening.
 *
 * @param before the log up to the restart, which holds where each rung's feed stood
 * @param after the log from the restart on. Rung names are joined through both windows' announces, because a
 *   recovered session may not announce again.
 */
export function socIndexRefusal(before: string, after: string, rungs: readonly string[]): string | null {
  const wereAt = manifestIndicesByRung(before);
  const nowAt = manifestIndicesByRung(joinedForRungNames(before, after));
  const problems = rungs.flatMap((rung) => {
    const earlier = wereAt.get(rung) ?? [];
    const later = nowAt.get(rung) ?? [];
    if (earlier.length === 0) {
      return [`${rung} published no live playlist before the restart, so where its feed stood is unknown`];
    }
    const top = Math.max(...earlier);
    const behind = later.filter((index) => index <= top || index === 0);
    return behind.length === 0
      ? []
      : [`${rung} wrote SOC index ${behind.join(', ')} at or below the ${top} it had reached`];
  });
  return problems.length === 0
    ? null
    : `a rung's live playlist did not continue its feed after the restart: ${problems.join('; ')}`;
}

/**
 * The later window's manifest lines with the earlier window's announces in front, so a stream that does not announce
 * again after a restart is still named by its rung. Only announces are carried over, never a manifest line.
 */
function joinedForRungNames(before: string, after: string): string {
  const announces = before.split('\n').filter((line) => announcedRungs(line).length > 0);
  return [...announces, after].join('\n');
}

/** Whether one feed's head moved between two readings: both readable, and the later one ends further on. */
export function headAdvanced(first: RungPlaylistParse, second: RungPlaylistParse): boolean {
  return first.lastSequence !== null && second.lastSequence !== null && second.lastSequence > first.lastSequence;
}

function headLabel(parse: RungPlaylistParse): string {
  return parse.rung ?? parse.streamId ?? parse.topic;
}

function headState(parse: RungPlaylistParse): string {
  if (parse.playlist === null) {
    return `unreadable (${parse.unreadable ?? 'no reason recorded'})`;
  }
  return `media sequence ${parse.mediaSequence ?? '?'} with ${parse.segments} segment(s), ending at ${parse.lastSequence ?? '?'}`;
}

/**
 * Which rung heads did not move between two readings of the same feeds, as a sentence, or null.
 *
 * Paired by topic, so a reading that came back in another order is still compared rung to rung. ⛔ An empty first
 * reading refuses: no head was read, and a check that was never made must not read as one that passed.
 */
export function headAdvanceRefusal(
  first: readonly RungPlaylistParse[],
  second: readonly RungPlaylistParse[],
): string | null {
  if (first.length === 0) {
    return 'no rung feed was read, so no playlist head could be seen to move';
  }
  const later = new Map(second.map((parse) => [parse.topic, parse]));
  const stuck = first.flatMap((parse) => {
    const after = later.get(parse.topic);
    if (after !== undefined && headAdvanced(parse, after)) {
      return [];
    }
    return [
      `${headLabel(parse)} went from ${headState(parse)} to ${after === undefined ? 'no reading' : headState(after)}`,
    ];
  });
  if (stuck.length === 0) {
    return null;
  }
  return (
    `${stuck.length} of ${first.length} rung playlist head(s) did not move on the gateway: ${stuck.join('; ')}. A head ` +
    'that stands still is a frozen broadcast to anyone joining on that rung, whatever the uploader log says'
  );
}

/** One line per rung: where its head stood at each reading. */
function describeHeadAdvance(first: readonly RungPlaylistParse[], second: readonly RungPlaylistParse[]): string {
  const later = new Map(second.map((parse) => [parse.topic, parse]));
  return first
    .map((parse) => {
      const after = later.get(parse.topic);
      return `  ${headLabel(parse)}: ${parse.lastSequence ?? '?'} -> ${after?.lastSequence ?? '?'}`;
    })
    .join('\n');
}

/** The header bee answers a feed read with, naming the index it resolved, as 16 hex digits. */
const FEED_INDEX_HEADER = /^swarm-feed-index:\s*([0-9a-f]+)\s*$/im;

/** The feed index out of a header dump, or null where the read answered none, which is a feed with nothing on it. */
export function feedIndexFromHeaders(headers: string): number | null {
  const hex = FEED_INDEX_HEADER.exec(headers)?.[1];
  return hex === undefined ? null : Number.parseInt(hex, 16);
}

/**
 * The SOC index one feed's head stands at, as the gateway resolves it, which is the index a session reopening that
 * topic must say it resumes at.
 */
export async function readFeedIndex(host: Host, cfg: E2EConfig, owner: string, topic: string): Promise<number | null> {
  return feedIndexFromHeaders(
    await host.localHeaders(cfg.ports.beeGatewayApi, `/feeds/${owner}/${feedTopicHexOf(topic)}`, 15),
  );
}

/** Every listed feed's playlist off the gateway, one at a time over the one ssh connection. */
export async function readRungHeads(
  host: Host,
  cfg: E2EConfig,
  owner: string,
  feeds: readonly RungFeed[],
): Promise<RungPlaylistParse[]> {
  const parses: RungPlaylistParse[] = [];
  for (const feed of feeds) {
    parses.push(await readOneRungPlaylist(host, cfg, owner, feed));
  }
  return parses;
}

/** A verdict a suite prints and asserts on, never throws on, the shape `checkPublishedTimeline` hands back. */
export interface RungPublishingVerdict {
  refusal: string | null;
  summary: string;
}

/** How often the heads are re-read while waiting for every one of them to move. */
const HEAD_POLL_MS = 3_000;

interface HeadsAdvanceWait {
  owner: string;
  feeds: readonly RungFeed[];
  /** How long every head is given to move past the first reading. A few segments is plenty on a healthy stage. */
  timeoutMs: number;
  /** Injected so a test drives the window instead of spending it, as `waitFor` takes one. */
  clock?: { now: () => number; wait: (ms: number) => Promise<void> };
}

/**
 * Read every rung head, then keep re-reading until each has moved past that first reading or the time runs out.
 *
 * Polled rather than read twice at a fixed spacing, so a rung that publishes late in the window is not refused for the
 * spacing, and a rung that never moves is refused with what it held at the last read rather than at an arbitrary one.
 */
export async function waitForRungHeadsAdvance(
  host: Host,
  cfg: E2EConfig,
  { owner, feeds, timeoutMs, clock = { now: () => Date.now(), wait: sleep } }: HeadsAdvanceWait,
): Promise<RungPublishingVerdict> {
  const first = await readRungHeads(host, cfg, owner, feeds);
  const deadline = clock.now() + timeoutMs;
  let latest = first;
  let refusal = headAdvanceRefusal(first, latest);

  while (refusal !== null && clock.now() < deadline) {
    await clock.wait(HEAD_POLL_MS);
    latest = await readRungHeads(host, cfg, owner, feeds);
    refusal = headAdvanceRefusal(first, latest);
  }
  return {
    refusal,
    summary: `  rung playlist heads, last sequence at first read -> latest read:\n${describeHeadAdvance(first, latest)}`,
  };
}

/** What {@link checkRungPlaylistsLive} reads, and how long it may wait for each part. */
interface RungPlaylistsLiveCheck {
  /** This suite's own uploader log window, re-read on every poll. */
  log: () => Promise<string>;
  /**
   * The rung names that must publish, or null on a single rendition, where the one stream that uploaded is the rung.
   */
  rungs: readonly string[] | null;
  /** Live manifest publishes each rung must have made in the window. */
  minPublishes: number;
  /** How long the publishes are given to reach `minPublishes`. */
  publishWaitMs: number;
  /** How long every head is given to move. */
  headWaitMs: number;
  /**
   * An earlier log window whose rung announces name this one's streams. A session rebuilt from a recovery entry does
   * not announce again, so without it a recovered rung's lines carry a stream id and no rung name.
   */
  namesFrom?: string;
  /**
   * Whether a stale warning refuses. True on every healthy suite. A fault suite passes false and reads its own
   * post-fault window instead, where any stale warning is again a refusal.
   */
  refuseStale?: boolean;
  /**
   * The signer whose feeds the heads are read under. Discovered from the catalog's own log line when absent, which is
   * right on a standalone stage. An admin-mode stage names it on the declared stream, and its catalog writes that line
   * once at boot and never again, so after an hour or two of uptime no log tail reaches it.
   */
  owner?: string;
  /** Injected so a test drives the waits instead of spending them, as `waitFor` takes one. */
  clock?: { now: () => number; wait: (ms: number) => Promise<void> };
}

/**
 * H1 and H2 together: every rung published at least n live playlists, the uploader called none of them stale, and every
 * rung's head moved on the gateway. What every ladder suite that claims a healthy broadcast asks, so that "segments but
 * no playlist" cannot pass anywhere.
 *
 * ⛔ Every part is read and reported even when an earlier one refused, because the three together say which half
 * broke: publishes missing in the log and a still head is the uploader, publishes present and a still head is the feed
 * write or the gateway.
 */
export async function checkRungPlaylistsLive(
  host: Host,
  cfg: E2EConfig,
  {
    log,
    rungs,
    minPublishes,
    publishWaitMs,
    headWaitMs,
    namesFrom,
    refuseStale = true,
    owner,
    clock,
  }: RungPlaylistsLiveCheck,
): Promise<RungPublishingVerdict> {
  const named = async (): Promise<string> => {
    const text = await log();
    return namesFrom === undefined ? text : joinedForRungNames(namesFrom, text);
  };
  const expectedOf = (text: string): string[] =>
    rungs === null ? [...segmentIndicesByStream(text).keys()] : [...rungs];
  const refusals: string[] = [];

  await waitFor(
    async () => {
      const text = await named();
      return everyRungPublishedAtLeast(text, expectedOf(text), minPublishes);
    },
    {
      timeoutMs: publishWaitMs,
      intervalMs: 3_000,
      clock,
      label: `every rung publishes ${minPublishes} live playlists`,
    },
  ).catch(() => undefined);

  const text = await named();
  const expected = expectedOf(text);
  const publishes = manifestPublishesByRung(text);
  const shortfall = publishShortfall(publishes, expected, minPublishes);
  if (shortfall !== null) {
    refusals.push(shortfall);
  }

  const stale = staleManifestWarnings(text);
  const staleRefusal = staleWarningRefusal(stale);
  if (refuseStale && staleRefusal !== null) {
    refusals.push(staleRefusal);
  }

  const feeds = rungFeedsOf(text).filter((feed) =>
    rungs === null ? feed.rung === null : feed.rung !== null && rungs.includes(feed.rung),
  );
  const unannounced = rungs === null ? [] : rungs.filter((rung) => !feeds.some((feed) => feed.rung === rung));
  if (unannounced.length > 0) {
    refusals.push(`${unannounced.join(', ')} never announced a feed, so its playlist head could not be read`);
  }

  const signer = owner ?? (await discoverCatalogFeed(host, cfg)).owner;
  const heads = await waitForRungHeadsAdvance(host, cfg, { owner: signer, feeds, timeoutMs: headWaitMs, clock });
  if (heads.refusal !== null) {
    refusals.push(heads.refusal);
  }

  const publishLine = expected.map((rung) => `${rung} ${publishes.get(rung) ?? 0}`).join(', ');
  return {
    refusal: refusals.length === 0 ? null : refusals.join('\n'),
    summary:
      `  live playlist publishes per rung: ${publishLine || 'none'}\n` +
      `  stale playlist warnings: ${stale.length}, held publishes (not refused): ${heldManifestNotices(text).length}\n` +
      heads.summary,
  };
}

/** The per-rung upload counter and the unlabelled publish-failure counter, as the uploader renders them. */
const RUNG_SEGMENTS_UPLOADED_METRIC = 'swarm_hls_rung_segments_uploaded_total';
const MANIFEST_PUBLISH_FAILURES_METRIC = 'swarm_hls_manifest_publish_failures_total';
/**
 * The per-rung live playlist counters, which an uploader built from the per-rung publish metrics change renders and an
 * older one does not. Read when present, and the log stands in when absent.
 */
const RUNG_MANIFEST_PUBLISHES_METRIC = 'swarm_hls_rung_manifest_publishes_total';
const RUNG_MANIFEST_PUBLISH_FAILURES_METRIC = 'swarm_hls_rung_manifest_publish_failures_total';

/** Where a row's playlist count came from: the uploader's own per-rung counter, or the log standing in for it. */
type PublishCountSource = 'metric' | 'log';

/** One rung's segment uploads by the uploader's own counter, beside the playlists it published. */
interface RungMetricRow {
  rung: string;
  segmentsUploaded: number;
  playlistsPublished: number;
  /** How far this rung's own publish-failure counter moved, or null on an uploader that renders none. */
  publishFailures: number | null;
}

/** H4: what moved between two scrapes, paired per rung. */
interface RungMetricPairing {
  rows: readonly RungMetricRow[];
  publishesFrom: PublishCountSource;
  /** How far the unlabelled failure counter moved, or null where either scrape lacked it. */
  manifestFailures: number | null;
}

/** How far each labelled sample of a family moved between two scrapes. Empty where the later scrape carries none. */
function rungDeltas(before: string, after: string, family: string): ReadonlyMap<string, number> {
  const earlier = rungCountersOf(before, family, 'rung');
  return new Map(
    [...rungCountersOf(after, family, 'rung')].map(([rung, total]) => [rung, total - (earlier.get(rung) ?? 0)]),
  );
}

/**
 * Pair the rung upload counter's movement with the playlists each rung published, rung by rung.
 *
 * The playlist count is the uploader's own per-rung publish counter where the scrape carries it, and the log's count,
 * H1, where it does not, which is every uploader built before the per-rung publish metrics. The same for failures:
 * each rung's own failure counter where present, else the one unlabelled counter for the whole uploader. Lifetime
 * counters, so both scrapes are needed and only the difference is read.
 */
export function rungMetricPairing(
  before: string,
  after: string,
  publishes: ReadonlyMap<string, number>,
): RungMetricPairing {
  const uploaded = rungDeltas(before, after, RUNG_SEGMENTS_UPLOADED_METRIC);
  const published = rungDeltas(before, after, RUNG_MANIFEST_PUBLISHES_METRIC);
  const failed = rungDeltas(before, after, RUNG_MANIFEST_PUBLISH_FAILURES_METRIC);
  // ⚠️ A labelled family renders no sample until a rung publishes, so 'log' also covers a new uploader on which no rung
  // has published yet: the log's count then stands in, and both readings agree that it is zero.
  const publishesFrom: PublishCountSource = published.size > 0 ? 'metric' : 'log';
  const rows = [...uploaded].map(([rung, segmentsUploaded]) => ({
    rung,
    segmentsUploaded,
    playlistsPublished: (publishesFrom === 'metric' ? published : publishes).get(rung) ?? 0,
    publishFailures: failed.size > 0 ? (failed.get(rung) ?? 0) : null,
  }));
  const failuresBefore = counterOf(before, MANIFEST_PUBLISH_FAILURES_METRIC);
  const failuresAfter = counterOf(after, MANIFEST_PUBLISH_FAILURES_METRIC);
  return {
    rows,
    publishesFrom,
    manifestFailures: failuresBefore === null || failuresAfter === null ? null : failuresAfter - failuresBefore,
  };
}

/**
 * Why the pairing says a healthy broadcast left a rung uploading with no playlist, or a publish failing, or null.
 *
 * ⛔ An empty pairing refuses: a scrape with no per-rung samples is a single rendition or a scrape that answered
 * nothing, and either way it said nothing about any rung. Where no rung carries its own failure counter, an unlabelled
 * counter that could not be read refuses too, since zero is what this is here to establish.
 */
export function rungMetricRefusal(pairing: RungMetricPairing): string | null {
  if (pairing.rows.length === 0) {
    return `the scrape carried no ${RUNG_SEGMENTS_UPLOADED_METRIC} samples, so no rung was paired at all`;
  }
  const problems: string[] = [];
  const silent = pairing.rows.filter((row) => row.segmentsUploaded > 0 && row.playlistsPublished === 0);
  if (silent.length > 0) {
    problems.push(
      `${silent.map((row) => `${row.rung} uploaded ${row.segmentsUploaded} segment(s)`).join(', ')} and published ` +
        `no playlist naming any of them, by the ${pairing.publishesFrom === 'metric' ? "uploader's per-rung counter" : 'log'}`,
    );
  }
  const perRung = pairing.rows.every((row) => row.publishFailures !== null);
  if (perRung) {
    const failing = pairing.rows.filter((row) => (row.publishFailures ?? 0) > 0);
    if (failing.length > 0) {
      problems.push(
        `${failing.map((row) => `${row.rung} ${row.publishFailures}`).join(', ')} failed live playlist publish(es) by ` +
          `${RUNG_MANIFEST_PUBLISH_FAILURES_METRIC} on a broadcast with no fault`,
      );
    }
  } else if (pairing.manifestFailures === null) {
    problems.push(`${MANIFEST_PUBLISH_FAILURES_METRIC} could not be read from both scrapes`);
  } else if (pairing.manifestFailures > 0) {
    problems.push(
      `${MANIFEST_PUBLISH_FAILURES_METRIC} moved by ${pairing.manifestFailures} on a broadcast with no fault`,
    );
  }
  return problems.length === 0 ? null : problems.join('; ');
}

/** One line per rung, for the run's log. */
export function describeRungMetricPairing(pairing: RungMetricPairing): string {
  const rows = pairing.rows.map(
    (row) =>
      `  ${row.rung}: ${row.segmentsUploaded} segment(s) uploaded, ${row.playlistsPublished} playlist(s) published ` +
      `by the ${pairing.publishesFrom}, ${row.publishFailures ?? 'no per-rung'} publish failure(s)`,
  );
  return [...rows, `  manifest publish failures, whole uploader: ${pairing.manifestFailures ?? 'unread'}`].join('\n');
}
