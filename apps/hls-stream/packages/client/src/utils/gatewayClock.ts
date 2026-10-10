/**
 * How far the gateway's clock is from the viewer's, learned from the HTTP `Date` header.
 *
 * A ladder's time markers sit at addresses computed from the wall clock, ten seconds a period, so a
 * viewer whose clock is a minute off would ask for six periods that do not exist yet or are long
 * gone. The gateway's clock is close to the uploader's, both being servers, so the `Date` header of
 * every answer the Swarm client reads for the player and the stream list is the reference. An answer
 * without one leaves the correction as it was.
 *
 * A browser only shows a cross-origin response's `Date` when the gateway lists it in
 * `Access-Control-Expose-Headers`. Without that the correction stays zero, and a marker missed for a
 * wrong clock costs the search the player made before markers existed.
 */
export class GatewayClock {
  private offset = 0;

  constructor(private readonly viewerNow: () => number = () => Date.now()) {}

  /** Folds in the instant an answer's `Date` header names, in Unix milliseconds, as read just now. */
  noteServerTime(gatewayMs: number): void {
    if (!Number.isFinite(gatewayMs)) {
      return;
    }
    // `Date` is cut to the whole second, so the gateway's instant lies somewhere in the second after it.
    this.offset = gatewayMs + 500 - this.viewerNow();
  }

  /** What to add to the viewer's clock to read the gateway's. */
  offsetMs(): number {
    return this.offset;
  }
}

/** The one the Swarm client feeds from the player's and the stream list's answers and the player reads. */
export const gatewayClock = new GatewayClock();
