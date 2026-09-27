export const CATALOG_STATE_LIVE = 'live' as const;
export const CATALOG_STATE_VOD = 'vod' as const;
/**
 * Announced, but nothing has been broadcast under the topic yet.
 *
 * Written by the admin, which publishes a catalog entry when a broadcast is *scheduled* rather than when it starts.
 * The uploader never writes this and has no lifecycle that maps to it.
 *
 * ⛔ **A scheduled entry has no manifest feed.** Its topic is a promise, not a stream, so asking the gateway for a
 * playlist under it is a guaranteed miss rather than a slow hit. Telling that apart from "live, and the first segment
 * has not landed yet" is the whole reason this literal exists: a reader that cannot will spend a fetch, and a spinner,
 * on every announced broadcast.
 */
export const CATALOG_STATE_SCHEDULED = 'scheduled' as const;

export const CATALOG_STATES = [CATALOG_STATE_LIVE, CATALOG_STATE_VOD, CATALOG_STATE_SCHEDULED] as const;

/**
 * What a catalog entry says about a broadcast: announced, still running, or a finished recording.
 *
 * Widened rather than versioned. A catalog entry is JSON on a feed that more than one writer writes, so entries
 * written before a state existed keep their old shape forever and a reader has to carry all of them. The rule that
 * keeps that safe: only `live` is live, and everything a reader does not recognise is treated as not live. So a
 * reader checks this as any string, and only a writer is held to this list.
 */
export type CatalogState = (typeof CATALOG_STATES)[number];
