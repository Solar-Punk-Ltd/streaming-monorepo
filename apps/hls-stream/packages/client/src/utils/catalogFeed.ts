import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { nextFeedRequest } from '@swarm-hls-stream/shared';

import { contentText, type SwarmAnswer } from '@/swarm/answers';
import type { SwarmReader } from '@/swarm/client';

import { FetchTimeoutError } from './fetchTimeoutError';

/**
 * How far a single read will walk forward before giving up and finishing on the next one.
 *
 * A bound rather than a limit anyone should hit. It exists because a follower that advances one slot
 * per poll has a catch-up rate equal to its poll rate, so a reader that falls behind never recovers.
 * Walking while the slots keep answering fixes that, and this caps what one poll can spend doing it.
 *
 * Thirty two is far more than a five second poll can fall behind on a catalog that gains a slot per
 * broadcast, and small enough that a pathological feed cannot hold the page for a minute.
 */
const MAX_WALK_PER_READ = 32;

/** What the stream list reads Swarm through: its feed's head, and its entries by index. */
type CatalogSource = Pick<SwarmReader, 'readFeedHead' | 'readFeedEntry'>;

/** The status a rate limit is reported under, a refusal like any other here. */
const TOO_MANY_REQUESTS = 429;

/** One catalog body, and the feed slot it was read from. */
export interface CatalogSnapshot {
  body: string;
  /**
   * The slot the body was read from, or null when the gateway did not say which.
   *
   * ⛔ Travels with the body rather than being read off {@link CatalogFeedReader.getIndex} afterwards,
   * because two reads can be in flight on one gateway at once and the one that lands last is not
   * always the newer. The app's first read runs beside the browse page's first poll, both start with
   * no position and resolve the head on their own, and the reader's position is whichever of them
   * wrote it last. Only this says which of two bodies is newer.
   */
  slot: bigint | null;
}

/** A response that arrived and was refused, as opposed to a transport failure or a timeout. */
class CatalogFetchError extends Error {
  constructor(
    path: string,
    readonly status: number,
  ) {
    super(`Catalog feed request to ${path} was refused with ${status}`);
    this.name = 'CatalogFetchError';
  }
}

/** An answer that is neither content nor not found, which is a read the gateway did not answer. */
type FailedAnswer = Exclude<SwarmAnswer, { kind: 'content' | 'not-found' }>;

/**
 * The error a failed answer reaches the browse page as. A refusing status, a rate limit among them,
 * is a {@link CatalogFetchError}, a window that ran out a {@link FetchTimeoutError}, and no answer at
 * all the error the request failed with, so the page's "Could not reach this gateway" reads as it did
 * when this reader fetched for itself.
 */
function failureOf(answer: FailedAnswer, path: string): unknown {
  switch (answer.kind) {
    case 'rate-limited':
      return new CatalogFetchError(path, TOO_MANY_REQUESTS);
    case 'unavailable':
      if (answer.cause.kind === 'status') {
        return new CatalogFetchError(path, answer.cause.status);
      }
      return answer.cause.kind === 'timeout' ? new FetchTimeoutError(path, answer.cause.timeoutMs) : answer.cause.error;
    case 'unsupported':
      return new Error(`No provider can read the stream list at ${path}`);
    case 'aborted':
      return new DOMException(`The stream list read of ${path} was cancelled`, 'AbortError');
  }
}

/**
 * Whether a failed slot read means only that nothing new can be said yet: a window that ran out or a
 * refusing status, the rate limit's included. Everything else is a gateway that cannot be reached at
 * all, or a read stopped or impossible, which the walk raises when it has nothing to salvage.
 */
function isNothingNewYet(answer: FailedAnswer): boolean {
  return answer.kind === 'rate-limited' || (answer.kind === 'unavailable' && answer.cause.kind !== 'network');
}

/**
 * Follows the app catalog feed by walking slots rather than resolving its head on every poll.
 *
 * The catalog is polled every five seconds forever and gains a slot per broadcast lifecycle event,
 * and it is never reset. Resolving the head each time costs a lookup that gets slower as the feed
 * grows: measured on this deployment at about 1s on a one slot feed, 4s at twenty, and 5s at a
 * thousand, against **4ms** for a slot read by explicit address. Past a few hundred events the poll
 * no longer fits inside its own interval and the catalog is never not in flight.
 *
 * So the head is resolved **once**, on the first read, and every read after that asks for the slot
 * after the one it holds. That is the same thing the player does, through the same shared helper, and
 * routing both through `nextFeedRequest` is deliberate: the last time this rule existed twice the two
 * copies diverged.
 *
 * **A miss is the ordinary answer, and it is not always cheap.** A walking reader asks for a slot that
 * does not exist yet on almost every poll, since broadcasts are rare. Measured 2026-08-05 on a single
 * node that wrote the catalog itself, that 404 cost 4ms at the median, with about one in twenty taking
 * 1.4s. Now that the catalog is written on another node, a miss on the gateway takes about a second,
 * with a tail past six seconds under load, and some end in a timeout or a status other than 404
 * rather than a clean miss. See the `feed-miss-cost` measurement (kept outside the repository).
 *
 * ⛔ **So once the head has answered, a slot read that times out or is refused means "nothing new
 * yet", never an error.** Raising it put the page's poll into SWR's error state, which skips the
 * regular reads and backs off, and one slow miss held an open page behind until a reload. Only a head
 * lookup that fails, or a gateway that cannot be reached at all, is raised. `MAX_WALK_PER_READ` still
 * bounds how long one read can walk.
 */
export class CatalogFeedReader {
  private index: FeedIndex | null = null;

  /**
   * Bumped by {@link reset}, pinned by every read, and compared before the position is written.
   *
   * ⛔ **Without it a reset that lands mid-read is undone by the read it was meant to cancel.** The
   * position is written after an await, and `setGatewayUrl` resets this reader synchronously while a
   * poll may be in flight against the node the viewer just left. That read then finished and wrote
   * the old node's slot number back. Every later poll asked the new node for the slot after it, a
   * node that has just been pointed at this catalog does not hold it, the walk broke with nothing
   * read, and the browse page kept the previous gateway's streams for the life of the tab. The
   * position never became null again either, so the head was never resolved on the new node.
   *
   * The same guard the modules around this one already carry: `ManifestFetcher` pins a topic
   * generation before a head read, `LadderFeedPoller` re-checks its entry after every await, and the
   * picker bumps a probe generation before it saves an address.
   */
  private generation = 0;

  constructor(
    private readonly owner: string,
    private readonly topic: Topic,
  ) {}

  /** The slot this reader has read, or null before its first successful read. Diagnostics and tests. */
  public getIndex(): FeedIndex | null {
    return this.index;
  }

  /**
   * Forgets the position, so the next read resolves the head again.
   *
   * Needed because the gateway can change under this reader. A different node has its own view of the
   * feed, and walking from an index established against the old one would ask for slots that node may
   * not have, which reads as a catalog that has stopped rather than one being followed from the wrong
   * place.
   *
   * A read already in flight is left to finish and return what it fetched, and is refused the
   * position it would have written. See {@link generation}.
   */
  public reset(): void {
    this.index = null;
    this.generation++;
  }

  /**
   * The newest catalog body and the slot it was read from, or null when there is nothing newer than
   * the last read.
   *
   * Null rather than a repeat of the previous body, so a caller can skip re-rendering an unchanged
   * list. Both existing callers already ignore a non-array, so null is inert for them.
   *
   * @param source The gateway's reads, which the Swarm client's stream-list reader gives. Each read has
   *   its ten second window, headers and body together, and the client keeps the gateway clock from
   *   every answer's `Date`, which is where the player's time markers take the time from.
   */
  public async read(source: CatalogSource, signal?: AbortSignal): Promise<CatalogSnapshot | null> {
    // Pinned before the first await and carried through, so every write this read makes is checked
    // against the reader it started on rather than against whatever the reader is by then.
    const generation = this.generation;

    if (this.index === null) {
      return this.readHead(source, generation, signal);
    }

    // A local cursor rather than reading `this.index` each turn. Assigning the field from a request
    // whose own type is derived from that field is circular, and TypeScript widens it to `any` rather
    // than refusing, so the overload that guarantees a slot request would have been silently lost.
    let cursor: FeedIndex = this.index;
    let newest: CatalogSnapshot | null = null;

    for (let step = 0; step < MAX_WALK_PER_READ; step++) {
      const request = nextFeedRequest(this.owner, this.topic, cursor);

      const answer = await source.readFeedEntry(this.owner, this.topic, Number(request.index.toBigInt()), { signal });
      if (answer.kind === 'not-found') {
        // The expected case on an idle catalog. The walk stops rather than retrying here, since the
        // poll comes round again.
        break;
      }
      if (answer.kind !== 'content') {
        // A failure is not the same shape as a refusal and must not lose what the walk already read.
        // `this.index` is committed per slot, inside this loop, while the body is only handed back
        // after it, so letting the rejection out drops a snapshot this walk successfully fetched
        // *and* keeps the index that consumed it. The next poll then asks for the slot after the one
        // it threw away, and since each slot carries the whole catalog rather than a delta, a
        // broadcast announced only in that slot is never offered to this reader again.
        //
        // ⛔ A timeout is "nothing new yet", even on the walk's first step, and so is a refusing
        // status. The reader holds a position, so this gateway has already answered for this
        // catalog, and the slot asked for is usually one nobody has written yet: a miss, which on a
        // gateway reading the catalog from another node takes about a second and has a tail past six
        // seconds under load. Raising it put the poll into SWR's error state, which skips the regular
        // reads and backs off instead, so one slow miss held an open page behind until a reload. The
        // slot is asked for again on the next poll. What the walk already read is handed back, since
        // each slot carries the whole catalog. A refused head lookup still raises, see `readHead`:
        // that is the read the browse page's choice between "Could not reach this gateway" and "No
        // streams here yet" rests on.
        //
        // Any other failure is a gateway that cannot be reached at all, and is raised when there is
        // nothing to salvage, so it reaches the caller as the error it is instead of reading as an
        // idle catalog.
        if (newest === null && !isNothingNewYet(answer)) {
          throw failureOf(answer, request.path);
        }
        return newest;
      }
      const text = contentText(answer);
      // ⛔ The body is checked before the position moves. The caller parses it after this returns,
      // so a body that arrived cut short used to fail that poll with the position already past it,
      // and every later poll asked for the slot after it. A change announced only in that slot never
      // reached the page. Treated like a refused read: the walk stops here, and this slot is asked
      // for again on the next poll.
      if (!isJson(text)) {
        return newest;
      }
      // The reader was reset while this slot was in flight, so it now belongs to a gateway the
      // viewer has left. What was already fetched is still handed back, since each slot carries the
      // whole catalog and the caller knows which gateway it asked, but neither the position nor
      // another request may go to the node that answered. See {@link generation}.
      if (generation !== this.generation) {
        return newest;
      }
      cursor = request.index;
      this.index = cursor;
      newest = { body: text, slot: cursor.toBigInt() };
    }
    return newest;
  }

  /**
   * The one slow read, paid once per reader rather than once per poll.
   *
   * The index comes from the response header rather than from counting, because the gateway is the
   * only thing that knows which slot it resolved to. Without it this reader would have to keep
   * resolving the head, which is the cost being removed.
   */
  private async readHead(
    source: CatalogSource,
    generation: number,
    signal?: AbortSignal,
  ): Promise<CatalogSnapshot | null> {
    const answer = await source.readFeedHead(this.owner, this.topic, { signal });
    // A catalog nobody has broadcast to has no head, which is nothing to show rather than a fault.
    if (answer.kind === 'not-found') {
      return null;
    }
    if (answer.kind !== 'content') {
      throw failureOf(answer, nextFeedRequest(this.owner, this.topic, null).path);
    }

    const text = contentText(answer);
    const slot = answer.feedIndex === null ? null : BigInt(answer.feedIndex);
    // A body without a usable index is still the catalog, so it is returned without a slot. The
    // position stays null and the next read resolves the head again, which is slow rather than wrong.
    // A head resolved on a gateway the viewer has since left keeps no position either, for the
    // stronger reason that the node now being asked has its own numbering. See {@link generation}.
    // Its slot is still handed back, because the slot describes the body rather than this reader.
    // A body that does not parse keeps no position either, so the next read resolves the head again
    // rather than walking on from a slot whose catalog never reached the page.
    if (slot !== null && generation === this.generation && isJson(text)) {
      this.index = FeedIndex.fromBigInt(slot);
    }
    return { body: text, slot };
  }
}

/**
 * Whether a catalog body parses at all. What it holds is checked by the stream list, which owns that
 * rule: a body that parses but does not validate still moves the position, so one writer's mistake
 * cannot hold every open page at that slot.
 */
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
