import {
  Bee,
  BeeResponseError,
  FeedIndex,
  PrivateKey,
  Topic,
} from '@ethersphere/bee-js';

import { getErrorMessage } from '../utils/errorUtils.js';

import { FeedFormatError, ThumbnailCheckError } from './errors/index.js';
import type { FeedGateway, FeedSnapshot } from './FeedGateway.js';
import { Logger } from './Logger.js';

const logger = Logger.getInstance();

/** Long enough for a busy node, short enough not to hold a publish open. */
// A reference the node does not hold is not a local miss: Bee asks the network
// first and answers 404 only when retrieval gives up, measured at 5-10 s on the
// test node against 0.2 s for a reference it has. The budget has to cover that
// or every stale reference reads as "could not verify".
const REFERENCE_CHECK_TIMEOUT_MS = 30_000;

export interface BeeFeedGatewayOptions {
  beeUrl: string;
  postageBatchId: string;
  feedPrivateKey: string;
  feedTopic: string;
}

/**
 * The real thing: the stream list feed as swarm-hls-stream's StreamCatalog
 * writes it — one feed, payload is the whole JSON array, one index per update.
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
export class BeeFeedGateway implements FeedGateway {
  private readonly bee: Bee;
  private readonly signer: PrivateKey;
  private readonly topic: Topic;
  private readonly postageBatchId: string;
  /** Kept for `hasReference`, which bee-js has no call for. */
  private readonly beeUrl: string;

  constructor(options: BeeFeedGatewayOptions) {
    this.bee = new Bee(options.beeUrl);
    this.beeUrl = options.beeUrl.replace(/\/+$/, '');
    this.signer = new PrivateKey(options.feedPrivateKey);
    this.topic = Topic.fromString(options.feedTopic);
    this.postageBatchId = options.postageBatchId;
  }

  async readLatest(): Promise<FeedSnapshot> {
    const owner = this.signer.publicKey().address();
    try {
      const result = await this.bee.feed
        .makeReader(this.topic, owner)
        .downloadPayload();
      const payload = result.payload.toJSON();
      if (!Array.isArray(payload)) {
        throw new FeedFormatError(`expected a JSON array, got ${typeof payload}`);
      }
      return { index: Number(result.feedIndex.toBigInt()), entries: payload };
    } catch (error) {
      // 404 = the topic was never written, 503 = the feed exists but has no
      // update yet. Both mean "start at index 0 with an empty list"; anything
      // else is a real failure and must not silently clear the catalog.
      if (
        error instanceof BeeResponseError &&
        (error.status === 404 || error.status === 503)
      ) {
        logger.info('[BeeFeedGateway] No feed update yet, starting fresh');
        return { index: null, entries: [] };
      }
      throw error;
    }
  }

  async write(entries: unknown[], index: number): Promise<string> {
    // Encoded here rather than handed over as a string: bee-js decides
    // between an inline payload and a wrapped chunk on `.length > 4096`,
    // which counts UTF-16 units for a string. One non-ASCII character in a
    // title is then counted as one unit but takes more than one byte, so a
    // list just under the limit would be rejected by the node.
    const payload = new TextEncoder().encode(JSON.stringify(entries));
    const result = await this.bee.feed
      .makeWriter(this.topic, this.signer)
      .uploadPayload(this.postageBatchId, payload, {
        index: FeedIndex.fromBigInt(BigInt(index)),
      });
    logger.info(
      `[BeeFeedGateway] Wrote feed index=${index} entries=${entries.length} bytes=${payload.length} ref=${result.reference.toHex()}`,
    );
    return result.reference.toHex();
  }

  async uploadThumbnail(
    bytes: Uint8Array,
    filename: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.bee.file.upload(
      this.postageBatchId,
      bytes,
      filename,
      { contentType },
    );
    logger.info(
      `[BeeFeedGateway] Uploaded thumbnail ${filename} (${bytes.length} bytes) ref=${result.reference.toHex()}`,
    );
    return result.reference.toHex();
  }

  async hasReference(reference: string): Promise<boolean> {
    const url = `${this.beeUrl}/bzz/${reference}/`;
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
      // reference is gone and pay to upload it again.
      throw new ThumbnailCheckError(reference, getErrorMessage(error));
    }

    if (response.ok) return true;
    if (response.status === 404) return false;
    throw new ThumbnailCheckError(
      reference,
      `the node answered ${response.status}`,
    );
  }
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}
