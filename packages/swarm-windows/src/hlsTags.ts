/**
 * The HLS tags a `live` window payload is checked and framed with, as bare tag names without a
 * trailing colon. Defined here, where the window convention lives, and re-exported by the stack's
 * own `hlsTags.ts`, so every builder and parser still shares one spelling of each.
 */
export const HLS_M3U = '#EXTM3U';
export const HLS_EXTINF = '#EXTINF';

/**
 * The Unix milliseconds at which the writer wrote a live window chunk. Not an RFC 8216 tag: it is
 * this stack's own, carried as the second line of a `live` window's playlist so a reader can tell how
 * far its clock runs ahead. hls.js ignores tags it does not know.
 */
export const HLS_SWARM_WRITTEN_AT = '#EXT-X-SWARM-WRITTEN-AT';
