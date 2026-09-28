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
  /** The payload exactly as the feed holds it, when the gateway read one. */
  payloadText?: string;
}

/**
 * Where a catalogue call goes: the Bee API of the catalogue node, and the batch
 * that stamps what is uploaded. Both come from the catalogue stamp the manager
 * pushed, read from the admin's database on every call (CatalogueBatchService),
 * never from the env file.
 *
 * A gateway is handed null only when it writes nowhere: FEED_GATEWAY=fake with
 * no catalogue stamp stored, so local runs and the tests need no manager.
 */
export interface CatalogueTarget {
  beeApiUrl: string;
  batchId: string;
}

/**
 * The text a list of entries is uploaded as. Made once per write, by the
 * caller, so the string `feed_writes` records is the string the gateway sent:
 * stamping the history again under another batch uploads these bytes as they
 * are, and the same bytes at the same index make the same chunk.
 */
export function encodeFeedPayload(entries: unknown[]): string {
  return JSON.stringify(entries);
}

export interface FeedGateway {
  readLatest(target: CatalogueTarget | null): Promise<FeedSnapshot>;
  /**
   * Writes `payloadText`, the whole list as `encodeFeedPayload` made it, at
   * `index`, stamped with the target's batch. Returns the new chunk's
   * reference hex.
   */
  write(payloadText: string, index: number, target: CatalogueTarget | null): Promise<string>;
  /** Uploads image bytes, stamped with the target's batch, and returns the Swarm reference hex. */
  uploadThumbnail(
    bytes: Uint8Array,
    filename: string,
    contentType: string,
    target: CatalogueTarget | null,
  ): Promise<string>;
  /**
   * Whether the target's node can still serve `reference`. A stored reference
   * outlives the gateway that produced it — FEED_GATEWAY=fake hands out
   * fabricated ones, the catalogue stamp can name another node, and a node can
   * lose its chunks — so a reference is checked before it is reused.
   *
   * Answers only "yes" or "no". Not knowing (node unreachable, timeout) is a
   * ThumbnailCheckError, never a `false`: re-uploading on a hiccup spends a
   * stamp for nothing.
   */
  hasReference(reference: string, target: CatalogueTarget | null): Promise<boolean>;
}
