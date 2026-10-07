/**
 * The node picker's Test: one gateway, each feature of the viewer, on this deployment's real content.
 *
 * Every check reads through a Swarm client made for that gateway alone, with no fallback, so a pass is
 * the gateway's own and a failure is not covered up by the event gateway behind it. Each check ends in
 * one sentence from `checkSentences`, and a failure says what the viewer can do about it.
 */
import { Topic } from '@ethersphere/bee-js';
import {
  ladderMarkerIdentifier,
  markerPeriodAt,
  parseLadderMarker,
  viewerCatalogSchema,
} from '@swarm-hls-stream/shared';

import { fetchPreviewManifest } from '@/components/StreamPreview/previewManifest';
import { isMasterPlaylist, masterVariants, parseManifest } from '@/components/SwarmHlsPlayer/playlist';
import { STREAM_STATUS_LIVE, STREAM_STATUS_SCHEDULED, type Stream } from '@/types/stream';
import { FetchTimeoutError } from '@/utils/fetchTimeoutError';
import { contentText, type SwarmAnswer } from '@/swarm/answers';
import { loadUrl as loadUrlOverHttp, type SwarmClient, type SwarmReader, type UrlLoadOptions } from '@/swarm/client';
import { PROBE_TIMEOUT_MS, type ReadOptions } from '@/swarm/provider';

import {
  failedReadSentence,
  MIXED_CONTENT,
  NO_SEGMENT,
  NOT_A_SWARM_GATEWAY,
  PASSED,
  probeSentence,
  SKIPPED,
} from './checkSentences';
import { isBlockedAsMixedContent } from './gatewayProbe';

/** What the Test checks, in the order the picker shows them. This viewer has no chat, so there is no chat check. */
export const CHECKS = ['connection', 'stream-list', 'player', 'previews', 'thumbnails'] as const;

type CheckName = (typeof CHECKS)[number];

export const CHECK_LABELS: Readonly<Record<CheckName, string>> = {
  connection: 'Connection',
  'stream-list': 'Stream list',
  player: 'Video',
  previews: 'Previews',
  thumbnails: 'Pictures',
};

type CheckOutcome = 'passed' | 'failed' | 'skipped';

export interface CheckResult {
  readonly check: CheckName;
  readonly outcome: CheckOutcome;
  readonly sentence: string;
}

/** Every read a check makes gets this long, the window the node picker has always given a node. */
export const CHECK_TIMEOUT_MS = PROBE_TIMEOUT_MS;

interface ProviderTestContext {
  /** A client made for the gateway under test alone. */
  readonly client: Pick<SwarmClient, 'reader' | 'probe'>;
  /** The gateway's address, which decides whether the browser refuses it before asking. */
  readonly address: string;
  /** The stream list feed this deployment publishes. */
  readonly catalog: { readonly owner: string; readonly topic: string };
  /**
   * The streams the page already shows, read from whichever gateway was in use. The other checks take
   * their stream from here when this gateway cannot read the list itself, so one failure does not hide
   * the rest.
   */
  readonly knownStreams: readonly Stream[];
  /** What to add to the viewer's clock to read the gateway's, for a ladder's time marker. */
  readonly clockOffsetMs?: number;
  readonly signal?: AbortSignal;
  /** Injected by tests. The client's own URL load otherwise. */
  readonly loadUrl?: (url: string, options?: UrlLoadOptions) => Promise<SwarmAnswer>;
  /** Injected by tests. The viewer's clock otherwise. */
  readonly now?: () => number;
  /** Injected by tests. Read from the page otherwise. */
  readonly pageProtocol?: string;
}

const passed = (check: CheckName, sentence: string): CheckResult => ({ check, outcome: 'passed', sentence });
const failed = (check: CheckName, sentence: string): CheckResult => ({ check, outcome: 'failed', sentence });
const skipped = (check: CheckName, sentence: string): CheckResult => ({ check, outcome: 'skipped', sentence });

/** A read that did not give its content, as the check's failure. */
const failedRead = (check: CheckName, what: string, answer: Exclude<SwarmAnswer, { kind: 'content' }>) =>
  failed(check, failedReadSentence(what, answer));

function currentPageProtocol(): string {
  return typeof window === 'undefined' ? '' : window.location.protocol;
}

/**
 * Runs every check against one gateway and answers one result per check, in {@link CHECKS} order.
 * Never rejects. The connection and the stream list are asked together, then the rest together.
 */
export async function testProvider(context: ProviderTestContext): Promise<CheckResult[]> {
  const pageProtocol = context.pageProtocol ?? currentPageProtocol();
  if (isBlockedAsMixedContent(context.address, pageProtocol)) {
    return CHECKS.map((check) => failed(check, MIXED_CONTENT));
  }

  const readWindow = windowOf(context);
  const [connection, list] = await Promise.all([
    checkConnection(context, readWindow),
    checkStreamList(context, readWindow),
  ]);
  const streams = list.streams ?? context.knownStreams;
  const rest = await Promise.all([
    checkPlayer(context, streams, readWindow),
    checkPreviews(context, streams),
    checkPicture(context, streams, readWindow),
  ]);
  return [connection, list.result, ...rest];
}

async function checkConnection(context: ProviderTestContext, readWindow: ReadOptions): Promise<CheckResult> {
  const found = await context.client.probe(readWindow);
  const sentence = probeSentence(found, CHECK_TIMEOUT_MS);
  return found.kind === 'ok' ? passed('connection', sentence) : failed('connection', sentence);
}

async function checkStreamList(
  context: ProviderTestContext,
  readWindow: ReadOptions,
): Promise<{ result: CheckResult; streams: Stream[] | null }> {
  const { owner, topic } = context.catalog;
  const answer = await context.client.reader('stream-list').readFeedHead(owner, Topic.fromString(topic), readWindow);
  if (answer.kind !== 'content') {
    return { result: failedRead('stream-list', 'the stream list', answer), streams: null };
  }
  const streams = streamListIn(contentText(answer));
  if (streams === null) {
    return { result: failed('stream-list', NOT_A_SWARM_GATEWAY), streams: null };
  }
  return { result: passed('stream-list', PASSED.streamList(streams.length, answer.feedIndex)), streams };
}

function streamListIn(text: string): Stream[] | null {
  try {
    const parsed = viewerCatalogSchema.safeParse(JSON.parse(text));
    return parsed.success ? (parsed.data as Stream[]) : null;
  } catch {
    return null;
  }
}

/** The stream every check after the list uses: a live one when there is one, else the newest with video. */
function streamToTest(streams: readonly Stream[]): Stream | null {
  const withVideo = streams.filter((stream) => stream.state !== STREAM_STATUS_SCHEDULED);
  return (
    withVideo.find((stream) => stream.state === STREAM_STATUS_LIVE) ??
    [...withVideo].sort((a, b) => b.timestamp - a.timestamp)[0] ??
    null
  );
}

function noStreamSkip(check: CheckName, streams: readonly Stream[]): CheckResult {
  return skipped(check, streams.length === 0 ? SKIPPED.noStreams : SKIPPED.noPlayable);
}

/** One playlist the player would read, and the text it was served. */
type PlaylistRead =
  | { readonly kind: 'served'; readonly text: string; readonly byMarker: boolean }
  | { readonly kind: 'failed'; readonly result: CheckResult };

async function checkPlayer(
  context: ProviderTestContext,
  streams: readonly Stream[],
  readWindow: ReadOptions,
): Promise<CheckResult> {
  const stream = streamToTest(streams);
  if (stream === null) {
    return noStreamSkip('player', streams);
  }
  const reader = context.client.reader('player');
  const read = await playlistOf(context, reader, stream, readWindow);
  if (read.kind === 'failed') {
    return read.result;
  }
  const segment = parseManifest(read.text).segments.find((candidate) => !candidate.gap);
  if (!segment) {
    return failed('player', NO_SEGMENT(stream.title));
  }
  const url = reader.urlFor(segment.uri, 'segment');
  if (url === null) {
    return failedRead('player', 'a segment of the video', { kind: 'unsupported' });
  }
  const loaded = await (context.loadUrl ?? loadUrlOverHttp)(url, readWindow);
  if (loaded.kind !== 'content') {
    return failedRead('player', 'a segment of the video', loaded);
  }
  return passed('player', read.byMarker ? PASSED.playerByMarker(stream.title) : PASSED.playerByEntry(stream.title));
}

/**
 * The playlist the player would start from: through the ladder's time marker on a live ladder, which is
 * how the player starts there, and otherwise a feed entry the stream list names. A ladder whose marker
 * is missing falls back to a feed entry, as the player falls back to its search.
 */
async function playlistOf(
  context: ProviderTestContext,
  reader: SwarmReader,
  stream: Stream,
  readWindow: ReadOptions,
): Promise<PlaylistRead> {
  const rungs = [...(stream.renditions ?? [])].sort((a, b) => a.bandwidth - b.bandwidth);
  if (stream.state === STREAM_STATUS_LIVE && rungs.length > 0) {
    const marker = await markerOf(context, reader, stream, readWindow);
    if (marker.kind === 'failed') {
      return marker;
    }
    const rung = marker.kind === 'found' ? rungs.find(({ topic }) => topicHex(topic) in marker.rungs) : undefined;
    if (marker.kind === 'found' && rung) {
      return entryOf(reader, stream, rung.topic, marker.rungs[topicHex(rung.topic)], readWindow, true);
    }
  }
  const lowest = rungs.find((rung) => rung.index !== undefined) ?? rungs[0];
  return lowest
    ? entryOf(reader, stream, lowest.topic, lowest.index ?? 0, readWindow, false)
    : entryOf(reader, stream, stream.topic, stream.index ?? 0, readWindow, false);
}

const topicHex = (topic: string) => Topic.fromString(topic).toHex();

type MarkerRead =
  | { readonly kind: 'found'; readonly rungs: Readonly<Record<string, number>> }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly result: CheckResult };

/** The marker of the previous period, and the one before when that is missing, as the player reads them. */
async function markerOf(
  context: ProviderTestContext,
  reader: SwarmReader,
  stream: Stream,
  readWindow: ReadOptions,
): Promise<MarkerRead> {
  const now = (context.now ?? Date.now)() + (context.clockOffsetMs ?? 0);
  const group = Topic.fromString(stream.topic);
  for (const period of [markerPeriodAt(now) - 1, markerPeriodAt(now) - 2]) {
    const answer = await reader.readSoc(stream.owner, ladderMarkerIdentifier(group, period).toHex(), readWindow);
    if (answer.kind === 'content') {
      const marker = parseLadderMarker(contentText(answer), period);
      if (marker) {
        return { kind: 'found', rungs: marker.rungs };
      }
    } else if (answer.kind !== 'not-found') {
      return { kind: 'failed', result: failedRead('player', 'the time marker', answer) };
    }
  }
  return { kind: 'missing' };
}

async function entryOf(
  reader: SwarmReader,
  stream: Stream,
  topic: string,
  index: number,
  readWindow: ReadOptions,
  byMarker: boolean,
): Promise<PlaylistRead> {
  const answer = await reader.readFeedEntry(stream.owner, Topic.fromString(topic), index, readWindow);
  if (answer.kind !== 'content') {
    return { kind: 'failed', result: failedRead('player', 'the playlist of the video', answer) };
  }
  const text = contentText(answer);
  if (!text.startsWith('#EXTM3U')) {
    return { kind: 'failed', result: failed('player', NOT_A_SWARM_GATEWAY) };
  }
  if (!isMasterPlaylist(text)) {
    return { kind: 'served', text, byMarker };
  }
  // An older ladder entry names its master. Its first variant is the playlist the player would play.
  const [variant] = masterVariants(text);
  return variant
    ? entryOf(reader, { ...stream, owner: variant.owner || stream.owner }, variant.topic, 0, readWindow, byMarker)
    : { kind: 'served', text, byMarker };
}

/**
 * The playlist a stream card takes its frame from, read the way the card reads it. The card gives its
 * reads no window of their own, so the check stops them itself once {@link CHECK_TIMEOUT_MS} is up.
 */
async function checkPreviews(context: ProviderTestContext, streams: readonly Stream[]): Promise<CheckResult> {
  const stream = streamToTest(streams);
  if (stream === null) {
    return noStreamSkip('previews', streams);
  }
  const stopper = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopper.abort();
  }, CHECK_TIMEOUT_MS);
  const stop = () => stopper.abort();
  context.signal?.addEventListener('abort', stop);
  try {
    const { res, segments } = await fetchPreviewManifest(context.client.reader('previews'), stream, stopper.signal);
    if (res.ok && segments.length > 0) {
      return passed('previews', PASSED.previews(stream.title));
    }
    if (res.ok) {
      return failed('previews', NO_SEGMENT(stream.title));
    }
    return failedRead('previews', 'the preview playlist', previewAnswerOf(res.status));
  } catch (error) {
    return failedRead('previews', 'the preview playlist', previewFailureOf(error, timedOut));
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener('abort', stop);
  }
}

/** The card's own reading of a refusal, back as the answer it came from. */
function previewAnswerOf(status: number): Exclude<SwarmAnswer, { kind: 'content' }> {
  if (status === 404) {
    return { kind: 'not-found', serverTimeMs: null };
  }
  if (status === 429) {
    return { kind: 'rate-limited', retryAfterMs: null, serverTimeMs: null };
  }
  return { kind: 'unavailable', cause: { kind: 'status', status } };
}

/** A card's read rejects for no answer, a window run out, or its signal, which the check's timer also fires. */
function previewFailureOf(error: unknown, timedOut: boolean): Exclude<SwarmAnswer, { kind: 'content' }> {
  if (timedOut || error instanceof FetchTimeoutError) {
    return { kind: 'unavailable', cause: { kind: 'timeout', timeoutMs: CHECK_TIMEOUT_MS } };
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { kind: 'aborted' };
  }
  return { kind: 'unavailable', cause: { kind: 'network', error } };
}

async function checkPicture(
  context: ProviderTestContext,
  streams: readonly Stream[],
  readWindow: ReadOptions,
): Promise<CheckResult> {
  const stream = streams.find((candidate) => candidate.thumbnail);
  if (!stream?.thumbnail) {
    return skipped('thumbnails', streams.length === 0 ? SKIPPED.noStreams : SKIPPED.noPicture);
  }
  const url = context.client.reader('previews').urlFor(stream.thumbnail, 'thumbnail');
  if (url === null) {
    return failedRead('thumbnails', 'pictures', { kind: 'unsupported' });
  }
  const loaded = await (context.loadUrl ?? loadUrlOverHttp)(url, readWindow);
  return loaded.kind === 'content'
    ? passed('thumbnails', PASSED.picture(stream.title))
    : failedRead('thumbnails', 'the picture', loaded);
}

/** Every read a check makes: {@link CHECK_TIMEOUT_MS} long, and stopped with the Test. */
const windowOf = (context: ProviderTestContext): ReadOptions => ({
  timeoutMs: CHECK_TIMEOUT_MS,
  signal: context.signal,
});
