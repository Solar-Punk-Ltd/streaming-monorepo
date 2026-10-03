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

/** One slot of the catalogue feed, as moving the catalogue uploads it again. */
export interface SlotToRestamp {
  index: number;
  /**
   * The exact string `feed_writes` recorded for the slot, or null when it has none: a write from before migration 013,
   * a head adopted from the network without its bytes, or a slot with no row at all. Null means the chunk's bytes are
   * read from the network through the target's node.
   */
  payloadText: string | null;
  /** The chunk reference the original write answered, when recorded; the slot's address is checked against it. */
  reference: string | null;
}

/** What uploading a slot again did. */
export interface RestampedSlot {
  /** The slot's chunk address, which is the same under every batch. */
  reference: string;
  /** Where its bytes came from: the recorded payload, signed again, or the chunk as the network holds it. */
  source: 'recorded' | 'network';
  /** Whether the payload is over 4096 bytes, so its content-addressed data was uploaded again as well. */
  wrapped: boolean;
}

/** A thumbnail's file as it was uploaded: the admin's stored bytes, name and type. */
export interface ThumbnailFile {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

/**
 * What moving the catalogue to another batch needs of a gateway: every slot of the feed, and every thumbnail the latest
 * entry names, uploaded again under the target's batch, byte for byte as they were first uploaded, so each lands at the
 * address it already has.
 */
export interface CatalogueRestamper {
  /**
   * Uploads slot `slot.index` of the feed again, stamped with the target's batch, through the target's node. From the
   * recorded payload when there is one, signed again with the feed key, which gives the same signature and so the same
   * chunk; otherwise from the chunk the network holds, uploaded with its own signature. A payload over 4096 bytes is a
   * wrapped chunk, whose data is uploaded again first. Throws when the bytes cannot be had or the address comes out
   * different.
   */
  restampSlot(slot: SlotToRestamp, target: CatalogueTarget): Promise<RestampedSlot>;
  /**
   * Uploads a thumbnail again under the target's batch: `file` when the admin still holds its bytes, otherwise the
   * file read back from the network through the target's node. Answers the reference the upload came to, which the
   * caller compares with `reference`.
   */
  restampThumbnail(reference: string, file: ThumbnailFile | null, target: CatalogueTarget): Promise<string>;
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
