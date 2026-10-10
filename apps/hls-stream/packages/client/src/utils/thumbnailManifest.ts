import { Topic } from '@ethersphere/bee-js';

import type { SwarmAnswer } from '@/swarm/answers';
import type { ReadOptions } from '@/swarm/provider';
import type { SwarmReader } from '@/swarm/client';

/** What a stream card reads a playlist through: a feed's head, or one of its entries by index. */
export type PreviewReads = Pick<SwarmReader, 'readFeedHead' | 'readFeedEntry'>;

const BYTES_PATH = '/bytes/';

/**
 * The one media line in a preview's playlist, always absolute against the gateway, or null when no
 * provider gives a URL for it.
 *
 * A preview playlist is handed to hls.js from memory under `PREVIEW_PLAYLIST_URL`, and hls.js resolves
 * a relative media line against the playlist's own URL. Resolving `/bytes/<ref>` against it returns
 * `memory:preview.m3u8/bytes/<ref>`, measured against hls.js 1.7.3's own resolver, which names no
 * gateway, so nothing downstream can work out which one was meant. The line has to name it here or it
 * cannot be named at all, so it is the URL the Swarm client gives for the
 * reference, which a Bee gateway makes absolute against the page's own address.
 *
 * A bare reference is what the uploader writes, and what every manifest published since 2026-08-13
 * holds. The other two shapes come from content published before that, when `MANIFEST_ACCESS_URL`
 * could prepend either a full URL or a rooted path. A full URL already names its gateway and is kept,
 * and a rooted `/bytes/<ref>` is read as the reference it names, since a recording keeps whatever its
 * manifest was published with.
 *
 * @param urlFor The URL the browser loads a reference from, which the client's previews reader gives.
 */
export function previewSegmentUrl(uri: string, urlFor: (reference: string) => string | null): string | null {
  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    return uri;
  }
  if (uri.startsWith(BYTES_PATH)) {
    return urlFor(uri.slice(BYTES_PATH.length));
  }
  return uri.startsWith('/') ? null : urlFor(uri);
}

/**
 * The playlist a stream card builds its thumbnail from.
 *
 * **A finished stream's catalog entry already carries the SOC index of its own final manifest**, set
 * by the uploader in `notifyStop`. Until now the client read that field in exactly one place and only
 * to sort by it, so every card resolved `/feeds/{owner}/{topic}` to search for a position it had
 * already been handed. Measured against the real catalog on 2026-08-05: the head lookup is **2647ms
 * at the median** against **4ms** for the slot, and the two returned byte-identical manifests for 12
 * entries out of 12, with the head resolving to exactly the published index every time. The previews
 * share a queue at concurrency 1, so those lookups are serial and ten cards is about 26 seconds of
 * them. See `docs/reviews/catalog-off-the-head-lookup.md`.
 *
 * A live entry has no index to give, because `notifyStart` publishes none, so it keeps the search.
 */
export function readPreviewPlaylist(
  reads: PreviewReads,
  owner: string,
  rawTopic: string,
  index?: number,
  options?: ReadOptions,
): Promise<SwarmAnswer> {
  const topic = Topic.fromString(rawTopic);
  return isAddressableSlot(index)
    ? reads.readFeedEntry(owner, topic, index, options)
    : reads.readFeedHead(owner, topic, options);
}

/**
 * Whether this is a slot number a feed can actually hold.
 *
 * The catalog is JSON pulled off the network and parsed unchecked, so this field is external input
 * however trusted its author. A negative, fractional or non-finite value throws inside `BigInt`, and
 * it would throw from a React effect while a card renders, taking out a preview that works today.
 * Falling back to the search is exactly what the code did before this function existed.
 */
function isAddressableSlot(index: number | undefined): index is number {
  return index !== undefined && Number.isSafeInteger(index) && index >= 0;
}
