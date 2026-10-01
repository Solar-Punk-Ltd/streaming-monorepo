/**
 * How long SRS takes, at most, to settle a connection whose publish the hook accepted while an older
 * connection was still publishing the same stream.
 *
 * SRS asks the publish hook before it decides anything else, so an accepted hook does not yet mean
 * the connection will publish. SRS then either takes the stream over, sending the older connection's
 * `on_unpublish` within milliseconds (11 to 45 ms in 30 of 30 takeovers measured on the fork), or
 * refuses the newcomer as busy, which SRT reports with the newcomer's own `on_unpublish` and RTMP
 * reports with nothing at all. A connection still unsettled after this long is therefore a refused
 * RTMP reconnect, and it is forgotten rather than left to hold the stream open.
 */
export const TAKEOVER_SETTLE_MS = 10_000;

/** Whether a publish's resume may go ahead now, or waits for an older connection to leave. */
export const RESUME_NOW = 'now';
export const RESUME_DEFERRED = 'deferred';
export type ResumeTiming = typeof RESUME_NOW | typeof RESUME_DEFERRED;

/** What an unpublish settles about a resume that was deferred. */
export const DEFERRAL_UNCHANGED = 'unchanged';
/** The older connection the deferred resume waited for has left, so it goes ahead now. */
export const DEFERRAL_FIRES = 'fires';
/** The connection whose resume was deferred has left first, so SRS refused it and nothing resumes. */
export const DEFERRAL_DROPPED = 'dropped';
export type DeferralOutcome = typeof DEFERRAL_UNCHANGED | typeof DEFERRAL_FIRES | typeof DEFERRAL_DROPPED;

export interface Departure {
  /** Whether no accepted connection is left, so the stream's publisher has really gone. */
  lastLeft: boolean;
  deferral: DeferralOutcome;
}

interface AcceptedConnection {
  acceptedAt: number;
  /** Accepted while an older connection was still publishing, and not yet settled by SRS. */
  contested: boolean;
}

interface StreamConnections {
  /** In the order the hook accepted them, which is the order `isOlder` reads. */
  accepted: Map<string, AcceptedConnection>;
  /** A connection was accepted without a client id, so there is no evidence to tell connections apart. */
  unidentified: boolean;
  /** The connection whose resume waits for an older one to leave. */
  deferred?: string;
}

/**
 * Per stream, the connections whose publish the hook accepted and that have not unpublished yet.
 *
 * ⛔⛔ **The stream's publisher has gone only when the last of them has left.** One of them is the
 * live publisher and any other is a connection SRS has not settled yet. A refused SRT reconnect
 * unpublishes while the live publisher carries on, and a takeover's old connection unpublishes after
 * the new one was accepted, so acting on whichever unpublish arrives cleared a live ladder's base or
 * reported a live stream as disconnected.
 *
 * ⛔ **A publish accepted while an older connection is still here resumes nothing yet.** It may be
 * refused, and if it takes over, the old connection's last segment is flushed before its unpublish,
 * so a break armed at the new publish lands on the old connection's media. The resume waits for an
 * older connection to leave, and is dropped if the new one leaves first.
 *
 * Without a client id there is no evidence of a different connection, so the stream behaves as it
 * did before connections were told apart: every publish resumes at once and every unpublish acts.
 */
export class PublisherConnections {
  private readonly streams = new Map<string, StreamConnections>();

  constructor(private readonly now: () => number) {}

  /** Whether a publish from this connection would have to wait for an older one to leave. */
  timingFor(streamId: string, clientId: string | undefined): ResumeTiming {
    const { stream } = this.settle(streamId);
    if (clientId === undefined || stream === undefined || stream.unidentified) {
      return RESUME_NOW;
    }
    return [...stream.accepted.keys()].some((id) => id !== clientId) ? RESUME_DEFERRED : RESUME_NOW;
  }

  /** Record a publish the hook accepted, and say when its resume may go ahead. */
  accept(streamId: string, clientId: string | undefined): ResumeTiming {
    const timing = this.timingFor(streamId, clientId);
    const stream = this.streams.get(streamId);
    if (clientId === undefined) {
      this.streams.set(streamId, { accepted: new Map(), unidentified: true });
    } else if (stream === undefined || stream.unidentified) {
      this.streams.set(streamId, {
        accepted: new Map([[clientId, { acceptedAt: this.now(), contested: false }]]),
        unidentified: false,
      });
    } else {
      stream.accepted.set(clientId, { acceptedAt: this.now(), contested: timing === RESUME_DEFERRED });
      if (timing === RESUME_DEFERRED) {
        stream.deferred = clientId;
      }
    }
    return timing;
  }

  /** Record an unpublish, and say whether the publisher has gone and what became of a deferred resume. */
  leave(streamId: string, clientId: string | undefined): Departure {
    const { stream, droppedDeferral } = this.settle(streamId);
    let deferral: DeferralOutcome = droppedDeferral ? DEFERRAL_DROPPED : DEFERRAL_UNCHANGED;

    if (stream === undefined || stream.unidentified || clientId === undefined) {
      if (stream?.deferred !== undefined) {
        deferral = DEFERRAL_DROPPED;
      }
      this.streams.delete(streamId);
      return { lastLeft: true, deferral };
    }

    if (stream.deferred === clientId) {
      deferral = DEFERRAL_DROPPED;
      stream.deferred = undefined;
    } else if (stream.deferred !== undefined && this.isOlder(stream, clientId, stream.deferred)) {
      deferral = DEFERRAL_FIRES;
      const winner = stream.accepted.get(stream.deferred);
      if (winner) {
        winner.contested = false;
      }
      stream.deferred = undefined;
    }

    stream.accepted.delete(clientId);
    if (stream.accepted.size === 0) {
      this.streams.delete(streamId);
      return { lastLeft: true, deferral };
    }
    return { lastLeft: false, deferral };
  }

  /**
   * The stream's connections with every refused RTMP reconnect forgotten, and whether forgetting one
   * dropped a deferred resume. See {@link TAKEOVER_SETTLE_MS}.
   */
  private settle(streamId: string): { stream?: StreamConnections; droppedDeferral: boolean } {
    const stream = this.streams.get(streamId);
    if (stream === undefined) {
      return { droppedDeferral: false };
    }
    let droppedDeferral = false;
    for (const [id, connection] of stream.accepted) {
      if (connection.contested && this.now() - connection.acceptedAt >= TAKEOVER_SETTLE_MS) {
        stream.accepted.delete(id);
        if (stream.deferred === id) {
          stream.deferred = undefined;
          droppedDeferral = true;
        }
      }
    }
    if (stream.accepted.size === 0 && !stream.unidentified) {
      this.streams.delete(streamId);
      return { droppedDeferral };
    }
    return { stream, droppedDeferral };
  }

  private isOlder(stream: StreamConnections, clientId: string, than: string): boolean {
    const order = [...stream.accepted.keys()];
    const at = order.indexOf(clientId);
    return at !== -1 && at < order.indexOf(than);
  }
}
