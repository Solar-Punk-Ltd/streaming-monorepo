/**
 * How far the gateway's clock is from the viewer's, learned from the HTTP `Date` header.
 *
 * A ladder's time markers sit at addresses computed from the wall clock, ten seconds a period, so a
 * viewer whose clock is a minute off would ask for six periods that do not exist yet or are long
 * gone. The gateway's clock is close to the uploader's, both being servers, so the stream list's
 * `Date` header is the reference. A response without one leaves the correction as it was.
 *
 * A browser only shows a cross-origin response's `Date` when the gateway lists it in
 * `Access-Control-Expose-Headers`. Without that the correction stays zero, and a marker missed for a
 * wrong clock costs the search the player made before markers existed.
 */
export class GatewayClock {
  private offset = 0;

  constructor(private readonly viewerNow: () => number = () => Date.now()) {}

  /** Folds in the `Date` of a response that has just arrived. */
  noteResponse(headers: Headers): void {
    const date = headers.get('date');
    const gatewayMs = date === null ? Number.NaN : Date.parse(date);
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

/** The one the stream list feeds and the player reads, so both see the same correction. */
export const gatewayClock = new GatewayClock();
