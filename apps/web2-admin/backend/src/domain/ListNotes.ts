import {
  createNoteWindowWriter,
  STREAM_LIST_HEARTBEAT_MS,
  STREAM_LIST_NOTE_WINDOW_MS,
  type WindowWriteEvent,
  type WindowWriterClock,
} from '@streaming-monorepo/swarm-windows';

import { getErrorMessage } from '../utils/errorUtils.js';

import type { FeedGateway } from './FeedGateway.js';
import type { FeedIdentity } from './feedIdentity.js';
import type { FeedWriteRecord } from './FeedWriteRepository.js';
import { Logger } from './Logger.js';
import type { CatalogueTargets, FeedWriteLog } from './PublishService.js';

const logger = Logger.getInstance();

export interface ListNotesOptions {
  /** Where the catalogue's writes are recorded. Every record passes through here on its way there. */
  log: FeedWriteLog;
  feed: FeedIdentity;
  gateway: Pick<FeedGateway, 'writeNote'>;
  /** The node and batch a note goes through: the ones the catalogue is written with, read before every note. */
  targets: Pick<CatalogueTargets, 'forRead'>;
  /** The system clock and timers unless a test hands its own. */
  clock?: WindowWriterClock;
}

/**
 * The stream list's window notes, as the admin writes them.
 *
 * The list stays a feed. After each version a viewer finds a note in the current 10 s window naming the newest
 * index whose write finished, and with no change a heartbeat note once a minute, so it reads one note a window
 * instead of polling the next feed index, which is the early ask that makes Bee skip its peers for that address.
 * The convention and the writer are `@streaming-monorepo/swarm-windows`, the same code the standalone uploader's
 * list writer runs.
 *
 * It stands in front of the catalogue's write log, because a record there is the moment a version's write has
 * finished: `PublishService` records a version only after the gateway took it, and the boot check records a head it
 * adopts from the network. A record that fails, and a write that never got as far as one, is never named.
 *
 * The note's topic is the list's topic name, `FEED_TOPIC`, the text the feed topic is made from, so a reader
 * computes the address from the same setting it reads the feed with. The admin has no clock check, so the writer is
 * given no `clockTrusted` and writes whatever its clock says.
 */
export class ListNotes implements FeedWriteLog {
  private readonly log: FeedWriteLog;
  private readonly feed: FeedIdentity;
  private readonly gateway: Pick<FeedGateway, 'writeNote'>;
  private readonly targets: Pick<CatalogueTargets, 'forRead'>;
  private readonly clock: WindowWriterClock | undefined;
  private newest = -1;
  private writer: ReturnType<typeof createNoteWindowWriter> | undefined;

  constructor(options: ListNotesOptions) {
    this.log = options.log;
    this.feed = options.feed;
    this.gateway = options.gateway;
    this.targets = options.targets;
    this.clock = options.clock;
  }

  async record(write: FeedWriteRecord): Promise<void> {
    await this.log.record(write);
    this.newest = Math.max(this.newest, write.feedIndex);
  }

  lastWrite(owner: string, topic: string): Promise<{ index: number; entries: unknown[] } | null> {
    return this.log.lastWrite(owner, topic);
  }

  /** Reads the newest recorded write, then writes notes until {@link stop}. Calling it while started does nothing. */
  async start(): Promise<void> {
    if (this.writer !== undefined) return;
    const last = await this.log.lastWrite(this.feed.owner, this.feed.topicHex);
    this.newest = Math.max(this.newest, last?.index ?? -1);
    this.writer = createNoteWindowWriter({
      topic: this.feed.topic,
      windowMs: STREAM_LIST_NOTE_WINDOW_MS,
      heartbeatMs: STREAM_LIST_HEARTBEAT_MS,
      newestStored: () => this.newest,
      write: async (slot, payload) => {
        // forRead, not forWrite: a note is its own chunk, never a catalogue write, so it takes the current node and batch without the publish lock.
        const read = await this.targets.forRead();
        if ('skipped' in read) throw new Error(read.skipped);
        await this.gateway.writeNote(slot, payload, read.target);
      },
      onEvent: logNoteEvent,
      clock: this.clock,
    });
    this.writer.start();
  }

  /** Settles once the notes already being written have finished. Nothing is written after it returns. */
  async stop(): Promise<void> {
    await this.writer?.stop();
  }
}

function logNoteEvent(event: WindowWriteEvent): void {
  if (event.outcome === 'failed') {
    logger.warn(
      `[ListNotes] note for window ${event.window} not written, the next window carries it: ${getErrorMessage(event.error)}`,
    );
  } else if (event.outcome === 'missed') {
    logger.warn(`[ListNotes] note windows ${event.fromWindow} to ${event.toWindow} passed unwritten`);
  }
}
