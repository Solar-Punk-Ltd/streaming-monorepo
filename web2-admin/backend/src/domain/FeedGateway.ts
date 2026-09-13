/**
 * Everything this backend does to Swarm, behind one interface: read the stream
 * list feed, write it back, upload a thumbnail. The bee-js implementation is
 * BeeFeedGateway; FakeFeedGateway is an in-memory stand-in for unit tests and
 * for local runs with FEED_GATEWAY=fake.
 */
export interface FeedSnapshot {
  /**
   * Index of the latest update, or null when the feed has never been written.
   * The next write goes to `index === null ? 0 : index + 1`.
   */
  index: number | null;
  /**
   * The payload as a JSON array, element by element and untouched. Entries are
   * `unknown` on purpose: an entry this backend does not recognise belongs to
   * someone else and is rewritten verbatim rather than dropped.
   */
  entries: unknown[];
}

export interface FeedGateway {
  readLatest(): Promise<FeedSnapshot>;
  /** Writes the whole list at `index`. Returns the new chunk's reference hex. */
  write(entries: unknown[], index: number): Promise<string>;
  /** Uploads image bytes and returns the Swarm reference hex. */
  uploadThumbnail(
    bytes: Uint8Array,
    filename: string,
    contentType: string,
  ): Promise<string>;
  /**
   * Whether this gateway can still serve `reference`. A stored reference
   * outlives the gateway that produced it — FEED_GATEWAY=fake hands out
   * fabricated ones, BEE_URL can be repointed at another node, and a node can
   * lose its chunks — so a reference is checked before it is reused.
   *
   * Answers only "yes" or "no". Not knowing (node unreachable, timeout) is a
   * ThumbnailCheckError, never a `false`: re-uploading on a hiccup spends a
   * stamp for nothing.
   */
  hasReference(reference: string): Promise<boolean>;
}
