import { BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import PQueue from 'p-queue';

import { Rendition } from '../types.js';
import { retryUntilDeadlineAsync } from '../utils/common.js';

import { BeePublisherPool, FEED_LOOKUP_TIMEOUT_MS } from './BeePublisherPool.js';
import { Logger } from './Logger.js';
import { buildMasterPlaylist } from './MasterPlaylist.js';

const MASTER_RETRY_WINDOW_MS = 10_000;

/** Where a published master lives, and which of its indices holds the version just written. */
export interface PublishedMaster {
  topic: string;
  index: number;
}

export interface MasterPublishOptions {
  /**
   * Write nothing when the feed's newest master already says exactly this, and answer that master's
   * slot instead. For a ladder that is a recording, whose master every later report of a finished rung
   * would otherwise write again. See {@link MasterFeedWriter.publish}.
   */
  skipIfUnchanged?: boolean;
}

/** The newest master on a group's feed, as this process last wrote or read it. Null index: none yet. */
interface MasterFeedHead {
  index: FeedIndex | null;
  playlist: string | null;
}

/**
 * Publishes each ladder's multivariant playlist to a feed of its own.
 *
 * The feed's topic *is* the ladder's group id. That is deliberate rather than convenient: the
 * group is the one identifier every rung already agrees on and the catalog already carries, so a
 * viewer holding a catalog entry needs nothing further to find the master, and a rung that
 * restarts mid-ladder republishes to the same place instead of stranding a second master.
 *
 * The rung topics are derived the same way, from the group and the rung name (`rungTopicFor`), so a
 * rung that stopped and restarted while its siblings kept the ladder alive comes back onto the feed
 * it was already writing rather than stranding what it published there. What pays for that is
 * `StreamUploader.resumeFeedIndex`: a session whose topic outlived it reads the head before it
 * writes anything, so it appends above the previous session instead of overwriting it at index 0.
 */
export class MasterFeedWriter {
  private heads = new Map<string, MasterFeedHead>();
  private queue = new PQueue({ concurrency: 1 });
  private logger = Logger.getInstance();

  constructor(
    private readonly publishers: BeePublisherPool,
    private readonly signer: PrivateKey,
  ) {}

  public get owner(): string {
    return this.signer.publicKey().address().toHex();
  }

  /**
   * Writes the ladder's current master and reports where it landed.
   *
   * Serialised on a queue of its own. The caller today is the stream catalog, whose writes are
   * already serialised, but a master feed is per ladder rather than per process and nothing about
   * that guarantee is this class's to assume — two ladders publishing at once must not race on the
   * index map.
   *
   * ⛔⛔ **`skipIfUnchanged` is for a recording's master and nothing else.** Measured live 2026-10-15: a
   * four rung ladder's finalize wrote the same master four times within about 200 ms, one per rung's
   * report, and the recording was named at the second, so two slots above the named one held copies
   * of it, masters nobody announced in the slots a reader asks for what came next. Compared
   * on the queue, so a burst of reports lands one write however they interleave, and against the head a
   * fresh process reads, so a finalize resumed after a restart adds nothing either. A live master is
   * always written, because a new broadcast of the same declared stream can open with one byte for byte
   * the recording's, and it still has to land above it.
   */
  public async publish(
    group: string,
    renditions: Rendition[],
    options: MasterPublishOptions = {},
  ): Promise<PublishedMaster | null> {
    if (renditions.length === 0) {
      return null;
    }

    // `?? null` because p-queue types `add` as resolving to `T | void`: a task dropped by
    // `queue.clear()` never runs and yields nothing. Nothing clears this queue, but a silent
    // `undefined` reaching the catalog would repoint an entry at `topic: undefined`.
    const published = await this.queue.add(async () => {
      const topic = Topic.fromString(group);
      const head = await this.headOf(group, topic);
      const playlist = buildMasterPlaylist(this.owner, renditions);
      if (options.skipIfUnchanged && head.index !== null && head.playlist === playlist) {
        this.logger.debug(
          `[MasterFeedWriter] Master for ladder ${group} is unchanged at index ${head.index.toString()}, nothing written`,
        );
        return { topic: group, index: Number(head.index.toBigInt()) };
      }
      const index = head.index === null ? FeedIndex.fromBigInt(BigInt(0)) : head.index.next();
      const publisher = this.publishers.coordinator();

      // One writer per attempt, see DeadlineBee in BeePublisherPool.ts.
      await retryUntilDeadlineAsync(
        () =>
          publisher.bee.feed
            .makeWriter(topic, this.signer)
            .uploadPayload(publisher.stamp, playlist, { index, deferred: true }),
        MASTER_RETRY_WINDOW_MS,
      );

      this.heads.set(group, { index, playlist });
      this.logger.debug(
        `[MasterFeedWriter] Master for ladder ${group} written at index ${index.toString()} via ` +
          `${publisher.rung} with ${renditions.length} rung(s): ${renditions.map((r) => r.name).join(', ')}`,
      );

      return { topic: group, index: Number(index.toBigInt()) };
    });

    return published ?? null;
  }

  /**
   * The newest master on the group's feed.
   *
   * The first write of a process probes the feed rather than assuming index 0, because the group id
   * survives a restart: an uploader recovering a ladder mid-stream would otherwise overwrite the
   * master a viewer is already reading, and a feed cannot be rewound.
   */
  private async headOf(group: string, topic: Topic): Promise<MasterFeedHead> {
    const known = this.heads.get(group);
    if (known) {
      return known;
    }
    const read = await this.readHead(topic);
    this.heads.set(group, read);
    return read;
  }

  private async readHead(topic: Topic): Promise<MasterFeedHead> {
    try {
      // A lookup's own deadline, since the pool's 4 s is shorter than a feed lookup. See FEED_LOOKUP_TIMEOUT_MS.
      const reader = this.publishers
        .coordinator()
        .bee.feed.makeReader(topic, this.signer.publicKey().address(), { timeout: FEED_LOOKUP_TIMEOUT_MS });
      const data = await reader.downloadPayload();
      return { index: data.feedIndex, playlist: data.payload.toUtf8() };
    } catch (error) {
      // 404 = topic never used, 503 = topic exists with no entries yet. Either way this ladder's
      // master starts at index 0. Anything else is rethrown: publishing over an unknown state is
      // how a viewer ends up reading a master that describes a different ladder.
      if (error instanceof BeeResponseError && (error.status === 404 || error.status === 503)) {
        return { index: null, playlist: null };
      }
      throw error;
    }
  }
}
