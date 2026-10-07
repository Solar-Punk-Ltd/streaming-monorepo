import { Bee, BeeResponseError, Bytes, FeedIndex, Identifier, PrivateKey, Reference, Topic } from '@ethersphere/bee-js';

import { windowIdentifier, type WindowSlot } from '@streaming-monorepo/swarm-windows';

import { getErrorMessage } from '../utils/errorUtils.js';

import { withoutCatalogueNode } from './catalogueNodeText.js';
import { FeedFormatError, ThumbnailCheckError } from './errors/index.js';
import type {
  CatalogueRestamper,
  CatalogueTarget,
  FeedGateway,
  FeedSnapshot,
  RestampedSlot,
  SlotToRestamp,
  ThumbnailFile,
} from './FeedGateway.js';
import { Logger } from './Logger.js';

const logger = Logger.getInstance();

/** Long enough for a busy node, short enough not to hold a publish open. */
// A reference the node does not hold is not a local miss: Bee asks the network
// first and answers 404 only when retrieval gives up, measured at 5-10 s on the
// test node against 0.2 s for a reference it has. The budget has to cover that
// or every stale reference reads as "could not verify".
const REFERENCE_CHECK_TIMEOUT_MS = 30_000;

/**
 * One call of moving the catalogue: an upload, or a read of a chunk from the network. A chunk the network does not have
 * answers 404 after some seconds of retrieval, so a minute is a node that is not answering, and the move stops with a
 * reason rather than waiting for ever.
 */
const RESTAMP_CALL_TIMEOUT_MS = 60_000;

/** The largest payload a chunk holds; a feed payload above it is a wrapped chunk, as bee-js writes one. */
const CHUNK_PAYLOAD_SIZE = 4096;

/** A single-owner chunk: identifier (32) and signature (65), then the span (8) and payload of the chunk it wraps. */
const SOC_HEADER_SIZE = 32 + 65;

export interface BeeFeedGatewayOptions {
  feedPrivateKey: string;
  feedTopic: string;
}

/**
 * The real thing: the stream list feed as swarm-hls-stream's StreamCatalog
 * writes it — one feed, payload is the whole JSON array, one index per update.
 *
 * The node and the batch are not this gateway's. Every call is handed the
 * catalogue target its caller read from the stored catalogue stamp, so a new
 * designation, a moved node or a pinned batch takes effect on the next call
 * with nothing restarted. Only the key and the topic, which name the feed, are
 * fixed here.
 *
 * This gateway holds no index state of its own, and it is no longer asked to.
 * `readLatest` was once the source of the next index — head + 1 — on the
 * assumption that a node's feed lookup reflects an update that node itself
 * made. It does not: the head read back here lagged this backend's own write
 * by up to ~30 s on the test node, so writes 3-4 s apart computed the same
 * index and the later chunk replaced the earlier one, and the stale payload
 * that came with it put unpublished entries back on the catalogue.
 *
 * PublishService now takes both the index and the base payload from
 * `feed_writes`, and `readLatest` is what the boot check compares that against
 * and the fallback for a feed with no recorded write. `write` still refuses
 * nothing: the index it is given is the caller's decision.
 */
export class BeeFeedGateway implements FeedGateway, CatalogueRestamper {
  private readonly signer: PrivateKey;
  private readonly topic: Topic;
  /** The client of the last node called, kept while the targets name the same one. */
  private client: { url: string; bee: Bee } | null = null;

  constructor(options: BeeFeedGatewayOptions) {
    this.signer = new PrivateKey(options.feedPrivateKey);
    this.topic = Topic.fromString(options.feedTopic);
  }

  async readLatest(target: CatalogueTarget | null): Promise<FeedSnapshot> {
    const owner = this.signer.publicKey().address();
    try {
      const result = await this.bee(target).feed.makeReader(this.topic, owner).downloadPayload();
      const payload = result.payload.toJSON();
      if (!Array.isArray(payload)) {
        throw new FeedFormatError(`expected a JSON array, got ${typeof payload}`);
      }
      return { index: Number(result.feedIndex.toBigInt()), entries: payload, payloadText: result.payload.toUtf8() };
    } catch (error) {
      // 404 = the topic was never written, 503 = the feed exists but has no
      // update yet. Both mean "start at index 0 with an empty list"; anything
      // else is a real failure and must not silently clear the catalog.
      if (error instanceof BeeResponseError && (error.status === 404 || error.status === 503)) {
        logger.info('[BeeFeedGateway] No feed update yet, starting fresh');
        return { index: null, entries: [] };
      }
      throw error;
    }
  }

  async write(payloadText: string, index: number, target: CatalogueTarget | null): Promise<string> {
    const { batchId } = required(target);
    // Encoded here rather than handed over as a string: bee-js decides
    // between an inline payload and a wrapped chunk on `.length > 4096`,
    // which counts UTF-16 units for a string. One non-ASCII character in a
    // title is then counted as one unit but takes more than one byte, so a
    // list just under the limit would be rejected by the node.
    const payload = new TextEncoder().encode(payloadText);
    // Direct, so this returns on the storer's receipt rather than once this node alone holds the
    // chunk. bee-js defaults to deferred, which the catalogue inherited and never chose. The stream
    // list's window notes name a version only once its write has returned (the architecture
    // overview's "The stream list's notes"), so that return has to mean the network holds it.
    const result = await this.bee(target)
      .feed.makeWriter(this.topic, this.signer)
      .uploadPayload(batchId, payload, { index: FeedIndex.fromBigInt(BigInt(index)), deferred: false });
    logger.info(
      `[BeeFeedGateway] Wrote feed index=${index} bytes=${payload.length} batch=${batchId.slice(0, 8)}… ref=${result.reference.toHex()}`,
    );
    return result.reference.toHex();
  }

  async writeNote(slot: WindowSlot, payload: Uint8Array, target: CatalogueTarget | null): Promise<void> {
    const { batchId } = required(target);
    await this.bee(target)
      .soc.makeWriter(this.signer)
      .upload(batchId, windowIdentifier(slot), payload, { deferred: false });
  }

  async uploadThumbnail(
    bytes: Uint8Array,
    filename: string,
    contentType: string,
    target: CatalogueTarget | null,
  ): Promise<string> {
    const { batchId } = required(target);
    const result = await this.bee(target).file.upload(batchId, bytes, filename, { contentType });
    logger.info(
      `[BeeFeedGateway] Uploaded thumbnail ${filename} (${bytes.length} bytes) ref=${result.reference.toHex()}`,
    );
    return result.reference.toHex();
  }

  async hasReference(reference: string, target: CatalogueTarget | null): Promise<boolean> {
    const url = `${withoutTrailingSlash(required(target).beeApiUrl)}/bzz/${reference}/`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(REFERENCE_CHECK_TIMEOUT_MS),
      });
      if (response.status === 405 || response.status === 501) {
        // A node that only routes GET on /bzz. One byte answers the same
        // question; the rest of the body is dropped unread.
        response = await fetch(url, {
          headers: { Range: 'bytes=0-0' },
          signal: AbortSignal.timeout(REFERENCE_CHECK_TIMEOUT_MS),
        });
        await response.body?.cancel();
      }
    } catch (error) {
      if (isTimeout(error)) {
        // Retrieval that has not given up after this long is a reference the
        // network does not have either. Treating it as missing costs at most
        // one re-upload of the same bytes to the same batch, which is
        // content-addressed and therefore free of new chunks; treating it as
        // an error left a stale reference on the feed with no way out.
        logger.warn(
          `[BeeFeedGateway] reference ${reference} not retrievable within ${REFERENCE_CHECK_TIMEOUT_MS} ms; treating it as missing`,
        );
        return false;
      }
      // Unreachable, DNS, TLS: not an answer, so do not pretend the
      // reference is gone and pay to upload it again. The detail goes to the
      // console, so without the node's address.
      logger.warn(`[BeeFeedGateway] could not check reference ${reference} at ${url}: ${getErrorMessage(error)}`);
      throw new ThumbnailCheckError(reference, withoutCatalogueNode(getErrorMessage(error), target));
    }

    if (response.ok) return true;
    if (response.status === 404) return false;
    throw new ThumbnailCheckError(reference, `the node answered ${response.status}`);
  }

  /**
   * Uploads one slot again under the target's batch, as `CatalogueRestamper` says. The chunk is built the way bee-js's
   * `updateFeedWithPayload` built it for `write`: the identifier is keccak256(topic, index), a payload up to 4096 bytes
   * is the chunk's own payload, and a longer one is uploaded as content-addressed data whose root chunk the
   * single-owner chunk wraps. The signature is secp256k1 with RFC 6979 nonces, so signing the same identifier and
   * payload with the same key again gives the same 65 bytes, and the chunk is the one first uploaded, byte for byte.
   *
   * A slot with no recorded payload is read from the network, checked against its address (bee-js recovers the owner
   * from the signature and refuses a chunk that is not this feed's), and uploaded with the signature it carries.
   */
  async restampSlot(slot: SlotToRestamp, target: CatalogueTarget): Promise<RestampedSlot> {
    const bee = this.bee(target);
    const identifier = this.slotIdentifier(slot.index);
    const owner = this.signer.publicKey().address();
    const address = new Reference(Bytes.keccak256(Bytes.concat(identifier.toUint8Array(), owner.toUint8Array())));
    if (slot.reference !== null && slot.reference.toLowerCase() !== address.toHex()) {
      throw new Error(
        `slot ${slot.index} was recorded at chunk ${slot.reference}, not at the address this feed key and topic give it`,
      );
    }

    let signature: Uint8Array;
    let body: Uint8Array;
    let wrapped: boolean;
    if (slot.payloadText !== null) {
      const data = new TextEncoder().encode(slot.payloadText);
      wrapped = data.length > CHUNK_PAYLOAD_SIZE;
      const chunk = wrapped
        ? bee.unmarshalContentAddressedChunk(await this.uploadWrappedData(bee, target.batchId, data, slot.index))
        : bee.makeContentAddressedChunk(data);
      signature = chunk.toSingleOwnerChunk(identifier, this.signer).signature.toUint8Array();
      body = chunk.data;
    } else {
      const bytes = await bee.chunk.download(address, undefined, { timeout: RESTAMP_CALL_TIMEOUT_MS });
      const soc = bee.unmarshalSingleOwnerChunk(bytes, address);
      signature = soc.signature.toUint8Array();
      body = bytes.slice(SOC_HEADER_SIZE);
      wrapped = soc.span.toBigInt() > BigInt(CHUNK_PAYLOAD_SIZE);
      if (wrapped) {
        const root = bee.makeContentAddressedChunk(soc.payload.toUint8Array(), soc.span).address;
        const data = await bee.data.download(root, undefined, { timeout: RESTAMP_CALL_TIMEOUT_MS });
        await this.uploadWrappedData(bee, target.batchId, data.toUint8Array(), slot.index, root);
      }
    }

    const uploaded = await this.uploadSoc(target, owner.toHex(), identifier.toHex(), signature, body, slot.index);
    if (uploaded !== address.toHex()) {
      throw new Error(`slot ${slot.index} came back from the node as chunk ${uploaded}, not ${address.toHex()}`);
    }
    const source = slot.payloadText !== null ? 'recorded' : 'network';
    logger.info(
      `[BeeFeedGateway] Restamped feed index=${slot.index} from the ${source === 'recorded' ? 'recorded payload' : 'network'}${
        wrapped ? ', wrapped' : ''
      } batch=${target.batchId.slice(0, 8)}… ref=${uploaded}`,
    );
    return { reference: uploaded, source, wrapped };
  }

  async restampThumbnail(reference: string, file: ThumbnailFile | null, target: CatalogueTarget): Promise<string> {
    const bee = this.bee(target);
    const requestOptions = { timeout: RESTAMP_CALL_TIMEOUT_MS };
    const source: ThumbnailFile = file ?? (await this.readFile(bee, reference));
    const result = await bee.file.upload(
      target.batchId,
      source.bytes,
      source.filename,
      { contentType: source.contentType },
      requestOptions,
    );
    logger.info(
      `[BeeFeedGateway] Restamped thumbnail ${source.filename} (${source.bytes.length} bytes) batch=${target.batchId.slice(0, 8)}… ref=${result.reference.toHex()}`,
    );
    return result.reference.toHex();
  }

  /** A file as the network holds it, with the name and type its manifest gives, for a thumbnail the admin lost. */
  private async readFile(bee: Bee, reference: string): Promise<ThumbnailFile> {
    const read = await bee.file.download(reference, '', undefined, { timeout: RESTAMP_CALL_TIMEOUT_MS });
    return {
      bytes: read.data.toUint8Array(),
      filename: read.name ?? `${reference}.bin`,
      contentType: read.contentType ?? 'application/octet-stream',
    };
  }

  /** keccak256(topic, index): a slot's identifier, as bee-js's `makeFeedIdentifier` makes it. */
  private slotIdentifier(index: number): Identifier {
    const feedIndex = FeedIndex.fromBigInt(BigInt(index));
    return new Identifier(Bytes.keccak256(Bytes.concat(this.topic.toUint8Array(), feedIndex.toUint8Array())));
  }

  /**
   * Uploads a wrapped payload's data under the batch, as bee-js's `updateFeedWithPayload` does, and answers its root
   * chunk as the node now holds it: span and payload, the bytes the single-owner chunk wraps. Content-addressed, so
   * the same data splits to the same root it did the first time. `expected`, for data read back from the network, is
   * the root the slot already wraps, and the upload has to come to it.
   */
  private async uploadWrappedData(
    bee: Bee,
    batchId: string,
    data: Uint8Array,
    index: number,
    expected?: Reference,
  ): Promise<Uint8Array> {
    const requestOptions = { timeout: RESTAMP_CALL_TIMEOUT_MS };
    const { reference } = await bee.data.upload(batchId, data, undefined, requestOptions);
    if (expected && !reference.equals(expected)) {
      throw new Error(
        `the data of slot ${index} came back from the node as ${reference.toHex()}, not the ${expected.toHex()} it wraps`,
      );
    }
    const root = await bee.chunk.download(reference, undefined, requestOptions);
    if (!bee.unmarshalContentAddressedChunk(root).address.equals(reference)) {
      throw new Error(`the root chunk of slot ${index}'s data does not hash to ${reference.toHex()}`);
    }
    return root;
  }

  /**
   * `POST /soc/{owner}/{identifier}?sig=`, the call bee-js's `uploadSingleOwnerChunk` makes, with a signature handed
   * in rather than made here, which bee-js has no public call for. The body is the wrapped chunk's span and payload.
   */
  private async uploadSoc(
    target: CatalogueTarget,
    owner: string,
    identifier: string,
    signature: Uint8Array,
    body: Uint8Array,
    index: number,
  ): Promise<string> {
    const url = `${withoutTrailingSlash(target.beeApiUrl)}/soc/${owner}/${identifier}?sig=${new Bytes(signature).toHex()}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'swarm-postage-batch-id': target.batchId },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(RESTAMP_CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`the node answered ${response.status} to the upload of slot ${index}`);
    }
    const answer = (await response.json()) as { reference?: unknown };
    if (typeof answer.reference !== 'string') throw new Error(`the node named no reference for slot ${index}`);
    return answer.reference.toLowerCase();
  }

  private bee(target: CatalogueTarget | null): Bee {
    const { beeApiUrl } = required(target);
    if (this.client?.url !== beeApiUrl) this.client = { url: beeApiUrl, bee: new Bee(beeApiUrl) };
    return this.client.bee;
  }
}

/**
 * The real gateway writes somewhere, so it is always handed a catalogue target: the catalogue batch service refuses
 * before any call when no stamp is stored. Reaching this is a wiring mistake, and it says so rather than calling a
 * node at `undefined`.
 */
function required(target: CatalogueTarget | null): CatalogueTarget {
  if (!target) throw new Error('BeeFeedGateway was called without a catalogue stamp to write through');
  return target;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
