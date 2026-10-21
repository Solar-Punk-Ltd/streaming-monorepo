/**
 * How many segment URLs {@link SegmentNames} keeps. A three-hour recording of two-second segments on a
 * four-rung ladder names about 21,600, so this holds a whole long session with room to spare. The oldest
 * name goes first, and a URL whose name was dropped loads from where it was named.
 */
const SEGMENT_NAMES_KEPT = 50_000;

/**
 * The Swarm reference behind every segment URL the player named, so a segment hls.js asks for by a URL
 * one source gave can be renamed by the source read from now.
 *
 * Recorded where the URL is made rather than parsed back out of it, because each provider spells its
 * URL its own way, and because only a URL the player named is the player's to rename. A recording that
 * wrote its publisher's gateway into its manifest, or a preview named through the previews' source,
 * is never in here.
 */
export class SegmentNames {
  private readonly references = new Map<string, string>();

  remember(url: string, reference: string): void {
    this.references.delete(url);
    this.references.set(url, reference);
    if (this.references.size > SEGMENT_NAMES_KEPT) {
      const oldest = this.references.keys().next().value;
      if (oldest !== undefined) {
        this.references.delete(oldest);
      }
    }
  }

  /** The reference `url` was named for, or null when the player never named it. */
  referenceOf(url: string): string | null {
    return this.references.get(url) ?? null;
  }
}
