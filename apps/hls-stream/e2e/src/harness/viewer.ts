import { FeedIndex, Identifier, Topic } from '@ethersphere/bee-js';
import {
  parseWindowNote,
  STREAM_LIST_NOTE_WINDOW_MS,
  windowIdentifier,
  type WindowNote,
} from '@swarm-hls-stream/shared';
import { Binary } from 'cafe-utility';

import { containerName, type E2EConfig } from '../config.js';

import type { Host } from './host.js';

/**
 * Viewer-facing helpers: read the stream catalog the client's StreamBrowser loads, resolved through
 * the bee-GATEWAY (not the uploader's private bee). This is the true player-visible layer — the same
 * `GET /feeds/{owner}/{topic}` the client makes. The catalog feed's owner + hashed topic are
 * discovered from the uploader's own logs so nothing is hard-coded to one deployment's stream key.
 */

export type StreamState = 'live' | 'vod';

/** One entry in the stream catalog JSON the uploader publishes and the client renders. */
export interface CatalogEntry {
  title: string;
  owner: string;
  topic: string;
  state: StreamState;
  /** Where a recording written on feeds is. A writer on time windows names `recording` instead. */
  index?: number;
  /** The reference of a finished broadcast's recording playlist, read with `GET /bytes/<recording>`. */
  recording?: string;
  duration?: number;
  mediatype: string;
  timestamp: number;
  /**
   * Present on a ladder entry: one per rung, each with its own session topic and what a player builds
   * the ladder's master playlist from. On a finished entry, only the rungs that recorded, since a rung
   * whose stop failed moves to `unfinishedRungs`.
   */
  renditions?: { name: string; topic: string; width?: number; height?: number; bandwidth?: number }[];
}

/**
 * Whether an entry belongs to a broadcast identified by its announced session topics.
 *
 * A single-rendition entry's own `topic` is the session topic. A ladder entry's own `topic` is its
 * lowest rung's, so the identity of every other rung lives in the rung topics under `renditions`.
 * Matching on `entry.topic` alone therefore finds single-rendition broadcasts and most of a ladder
 * only by luck (found live 2026-08-27, twice, when the entry's topic was a master feed's).
 */
export function entryCarriesTopic(entry: CatalogEntry, topics: ReadonlySet<string>): boolean {
  if (topics.has(entry.topic)) {
    return true;
  }
  return (entry.renditions ?? []).some((rendition) => topics.has(rendition.topic));
}

/** Feed location = signer address (owner) + the hashed `swarm-stream` list topic. */
export interface CatalogFeed {
  owner: string;
  topicHex: string;
  /**
   * The text the topic is made from, which the list's notes are addressed by. Present only when the
   * line that named the feed also named it, and it hashes to `topicHex`.
   */
  topicName?: string;
}

/**
 * Both `[StreamCatalog]` log variants print `owner=<40hex> … topicHex=<64hex>` in that order, and
 * the newer ones `topic="<name>"` between the two.
 */
const RE_CATALOG_FEED =
  /\[StreamCatalog\][^\n]*owner=([0-9a-f]{40})(?:[^\n]*?topic="([^"\n]*)")?[^\n]*topicHex=([0-9a-f]{64})/g;

/**
 * How much further back to look when the recent log holds no catalog line.
 *
 * The feed location does not change for the life of the deployment, so any line ever written names
 * it. A shallow tail finds one whenever a broadcast has just run, which is the case inside a full
 * suite: each scenario publishes, so the next one's discovery is cheap. Run a scenario on its own
 * against a deployment that has been idle for hours and the last line has scrolled away, and the
 * suite failed before reaching anything it meant to test.
 */
const DEEP_TAIL_MULTIPLIER = 50;

/** Discover the catalog feed (owner + hashed topic) from the uploader's own StreamCatalog log lines. */
export async function discoverCatalogFeed(host: Host, cfg: E2EConfig, tail: number = 1000): Promise<CatalogFeed> {
  const container = containerName(cfg, 'stream-uploader');
  const lastMatch = (text: string) => [...text.matchAll(RE_CATALOG_FEED)].at(-1);

  const match =
    lastMatch(await host.logs(container, tail)) ?? lastMatch(await host.logs(container, tail * DEEP_TAIL_MULTIPLIER));
  if (!match) {
    throw new Error(
      `no [StreamCatalog] owner/topicHex line in the last ${tail * DEEP_TAIL_MULTIPLIER} lines of ${container} ` +
        '— cannot locate the catalog feed. The uploader has never announced a stream, or its log has rotated.',
    );
  }
  const [, owner, topicName, topicHex] = match;
  if (topicName !== undefined && Topic.fromString(topicName).toHex() === topicHex) {
    return { owner, topicHex, topicName };
  }
  return { owner, topicHex };
}

/** Bee answers `GET /soc/{owner}/{identifier}` with the chunk's payload, joined when it wraps more. */
function socPath(feed: CatalogFeed, identifier: Identifier): string {
  return `/soc/${feed.owner}/${identifier.toHex()}`;
}

function topicNameOf(feed: CatalogFeed): string {
  if (feed.topicName === undefined) {
    throw new Error(
      'the stream list topic name was not in the uploader log, so its notes cannot be addressed. ' +
        'An uploader from before the list notes logs none.',
    );
  }
  return feed.topicName;
}

/**
 * The stream list's note in one 10 s window, read through the gateway, or null when that window
 * holds none. Ask a window only after its end plus a margin: an earlier ask makes Bee skip its
 * peers for that address for about a minute, which is the delay the notes exist to avoid.
 */
export async function fetchListNote(
  host: Host,
  cfg: E2EConfig,
  feed: CatalogFeed,
  window: number,
): Promise<WindowNote | null> {
  const identifier = windowIdentifier({
    topic: topicNameOf(feed),
    kind: 'note',
    windowMs: STREAM_LIST_NOTE_WINDOW_MS,
    window,
  });
  const body = await host.localText(cfg.ports.beeGatewayApi, socPath(feed, identifier), 8);
  return parseWindowNote(new TextEncoder().encode(body));
}

/** One version of the list, the one at feed index `index`, as a note names it. */
export async function fetchCatalogAt(
  host: Host,
  cfg: E2EConfig,
  feed: CatalogFeed,
  index: number,
): Promise<CatalogEntry[]> {
  const identifier = new Identifier(
    Binary.keccak256(
      Binary.concatBytes(
        Topic.fromString(topicNameOf(feed)).toUint8Array(),
        FeedIndex.fromBigInt(BigInt(index)).toUint8Array(),
      ),
    ),
  );
  const body = JSON.parse(await host.localText(cfg.ports.beeGatewayApi, socPath(feed, identifier), 8)) as unknown;
  if (!Array.isArray(body)) {
    throw new Error(`the list version at index ${index} is not an array: ${JSON.stringify(body)?.slice(0, 200)}`);
  }
  return body as CatalogEntry[];
}

/**
 * Fetch + parse the catalog the viewer sees, resolved through the bee-gateway feed endpoint.
 *
 * ⛔ Validated at this boundary: mid-restart the gateway answers its own JSON error envelope, which
 * parses fine and is not a catalog. Cast through, `.find` on it took scenario I down as a TypeError
 * instead of a retry. Thrown instead, the callers' existing catch-to-empty reads it as "not yet".
 */
export async function fetchCatalog(host: Host, cfg: E2EConfig, feed: CatalogFeed): Promise<CatalogEntry[]> {
  const body = await host.localJson<unknown>(cfg.ports.beeGatewayApi, `/feeds/${feed.owner}/${feed.topicHex}`, 8);
  if (!Array.isArray(body)) {
    throw new Error(`the catalog feed answered with a non-array: ${JSON.stringify(body)?.slice(0, 200)}`);
  }
  return body as CatalogEntry[];
}
