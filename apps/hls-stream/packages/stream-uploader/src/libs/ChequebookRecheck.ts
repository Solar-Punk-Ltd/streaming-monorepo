import { LowChequebook, StartGateWarning } from '../types.js';
import { describeFailure } from '../utils/transportFailure.js';

import { Clock, systemClock, Timer } from './Clock.js';
import { GateReading, latchedWarning, StartGate } from './StartGates.js';

/**
 * Where what the chequebook reads find is held for `/health`, which `StreamOrchestrator` is.
 *
 * Each list is replaced whole on every record, so what this reads back is exactly what `/health` reports.
 */
export interface ChequebookHealthStore {
  getStartGateWarnings(): readonly StartGateWarning[];
  recordStartGateWarnings(warnings: readonly StartGateWarning[]): void;
  recordLowChequebooks(nodes: readonly LowChequebook[]): void;
}

/** Where the reads are reported. Matches `Logger`, narrowed to the three methods used here. */
interface RecheckLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

interface ChequebookRecheckOptions {
  /** The chequebook gate, built the way the boot's pass ran it. */
  readonly gate: StartGate;
  /** How long after one read has answered the next one starts. `CHEQUEBOOK_RECHECK_MS`. */
  readonly intervalMs: number;
  readonly store: ChequebookHealthStore;
  readonly logger: RecheckLogger;
  /** Injected so a test can step time rather than wait a minute per read. */
  readonly clock?: Clock;
}

/**
 * The rungs one pass of the gate refused, keyed by rung, `undefined` being a single-node deployment's
 * one node. A rung absent from a pass is a node that holds its floor.
 */
type RefusedRungs = Map<string | undefined, GateReading>;

const MS_PER_SECOND = 1_000;

/**
 * Reads every publisher node's chequebook for the life of the process, takes the boot's chequebook
 * warning off `/health` as soon as each rung holds its floor, and names a rung that falls under the
 * floor after the boot as `chequebook_low`.
 *
 * ## The failures this exists for
 *
 * Under the shipped `chequebook-warn` a chequebook under its floor does not stop the boot. The gate
 * warns, the service starts, and the finding is latched onto `/health` as `start_gate_warned`. Nothing
 * read the chequebook again after that, so funding the node changed nothing anybody could see, and a
 * colleague testing the manager reported the uploader as stuck on 2026-09-25. From 2026-09-26 the
 * chequebook was read again while that warning stood, and not at all once it had cleared.
 *
 * So a node that drained later was invisible. On 2026-10-01 the 1080p node spent about 5 BZZ in two
 * hours, fell under the floor during a broadcast, and the recording lost that rung while `/health`
 * said nothing about it. Every node is therefore read for as long as the process runs, whatever the
 * boot found, and under `UPLOADER_START_GATES=refuse` too.
 *
 * ## What it reads, and what it reports
 *
 * The same gate the boot ran, over the same nodes, `intervalMs` after the previous read has answered:
 * one read per distinct node per interval. Reads never overlap, because a chequebook read is answered
 * off the chain and can take the whole gate timeout, and an older answer landing after a newer one
 * would put back a report the newer one had cleared.
 *
 * - A rung the boot warned about stays under `start_gate_warned` until a read finds it holding its
 *   floor, and is not named a second time as `chequebook_low`. Every other gate's warnings are kept: a
 *   postage warning from the boot is about a batch, and the chequebook says nothing about it.
 * - Any other rung its node answered about, a balance under the floor or a refusal to show the
 *   chequebook at all, is `chequebook_low`, and leaves it on the first read that finds it funded.
 * - A read that never reached the node, a timeout, a refused connection or a 5xx, changes nothing on
 *   `/health`. It establishes nothing about the balance: reporting it low would repeat the false alarm
 *   a timed out read raised on 2026-09-16, and clearing a rung on it would hide a real drain. It is
 *   warned about in the log, and a node that has stopped answering shows on the upload path anyway.
 *
 * ⛔ This reports and does nothing else. A low chequebook neither stops nor refuses a broadcast, and
 * nothing here moves money: funding a node is the owner's, from the node's own wallet.
 */
export class ChequebookRecheck {
  private readonly clock: Clock;
  private timer: Timer | null = null;
  private isStarted = false;
  private isStopped = false;
  private lastRefused: RefusedRungs = new Map();
  private lowRungs = new Set<string | undefined>();

  constructor(private readonly options: ChequebookRecheckOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /** Start reading. Called once the boot is over, whatever its gates found. */
  public start(): void {
    if (this.isStarted || this.isStopped) {
      return;
    }

    this.isStarted = true;
    const { gate, intervalMs, logger } = this.options;
    const held = this.heldWarnings();
    const boot =
      held.length === 0
        ? ''
        : ` ${gate.name} warned at boot on ${describeRungs(held.map((warning) => warning.rung))}, and that ` +
          'warning clears with no restart once the chequebook is funded.';
    logger.info(
      `[ChequebookRecheck] Reading every publisher node's chequebook every ${seconds(intervalMs)} for as long ` +
        `as this process runs, and reporting a node under the floor as chequebook_low.${boot}`,
    );
    this.scheduleNextRead();
  }

  /** Stop reading. A read already in flight finishes and changes nothing. */
  public stop(): void {
    this.isStopped = true;
    this.timer?.cancel();
    this.timer = null;
  }

  private scheduleNextRead(): void {
    // Unref'd, because a pending re-read is no reason to keep alive a process that is otherwise ending.
    this.timer = this.clock.setTimer(() => this.readAgainOrSayWhy(), this.options.intervalMs, { unref: true });
  }

  private readAgainOrSayWhy(): void {
    this.timer = null;
    this.readAgain()
      .catch((error: unknown) => {
        // Nothing inside a pass is expected to throw, since the gate's own failures are collected. Kept
        // reading anyway, because a loop that died here would leave every later drain unseen.
        this.options.logger.warn(`[ChequebookRecheck] a read failed and is tried again: ${describeFailure(error)}`);
      })
      .finally(() => {
        if (!this.isStopped) {
          this.scheduleNextRead();
        }
      });
  }

  private async readAgain(): Promise<void> {
    const held = this.heldWarnings();
    const refused = await this.readOnce(held);
    if (this.isStopped || refused === null) {
      return;
    }

    this.clearFundedBootWarnings(held, refused);
    this.recordLowRungs(held, refused);
    this.lastRefused = refused;
  }

  /**
   * One pass of the gate, as the rungs it refused, or null for a gate that threw rather than
   * collecting. An empty node set does that, and it says nothing about any rung, so it changes nothing.
   *
   * A rung refused as it was last time goes to debug, because a minute later it is not news. A rung
   * refused for the first time is a warning, with the gate's message, which names the node.
   */
  private async readOnce(held: readonly StartGateWarning[]): Promise<RefusedRungs | null> {
    const { gate, logger } = this.options;
    const refused: RefusedRungs = new Map();
    const isKnown = (rung: string | undefined) =>
      this.lastRefused.has(rung) || held.some((warning) => warning.rung === rung);
    const report = (rung: string | undefined, line: string) => (isKnown(rung) ? logger.debug(line) : logger.warn(line));

    try {
      await gate.run((refusal) => {
        const { rung } = latchedWarning(gate.name, refusal);
        refused.set(rung, refusal.reading);
        report(rung, `[ChequebookRecheck] ${refusal.message}`);
      });
    } catch (error) {
      report(undefined, `[ChequebookRecheck] ${gate.name} could not be read again: ${describeFailure(error)}`);
      return null;
    }

    return refused;
  }

  /** Drops each rung the boot warned about that this pass found holding its floor. Never adds one. */
  private clearFundedBootWarnings(held: readonly StartGateWarning[], refused: RefusedRungs): void {
    const { gate, store, logger } = this.options;
    const funded = held.filter((warning) => !refused.has(warning.rung));
    if (funded.length === 0) {
      return;
    }

    const otherGates = store.getStartGateWarnings().filter((warning) => warning.gate !== gate.name);
    const stillShort = held.filter((warning) => refused.has(warning.rung));
    store.recordStartGateWarnings([...otherGates, ...stillShort]);
    logger.info(
      `[ChequebookRecheck] ${describeRungs(funded.map((warning) => warning.rung))} now holds its floor, so ` +
        `${gate.name}'s boot warning there is off /health`,
    );
  }

  /**
   * Replaces the low list with every rung its node answered about, plus any rung already low whose read
   * failed this time, leaving out the rungs the boot's warning still covers.
   */
  private recordLowRungs(held: readonly StartGateWarning[], refused: RefusedRungs): void {
    const { store, logger } = this.options;
    const low = new Set<string | undefined>();

    for (const [rung, reading] of refused) {
      const isBootWarned = held.some((warning) => warning.rung === rung);
      if (!isBootWarned && (reading === 'answered' || this.lowRungs.has(rung))) {
        low.add(rung);
      }
    }

    const recovered = [...this.lowRungs].filter((rung) => !low.has(rung));
    this.lowRungs = low;
    store.recordLowChequebooks([...low].map(lowChequebook));

    if (recovered.length > 0) {
      logger.info(
        `[ChequebookRecheck] ${describeRungs(recovered)} holds its floor again, so chequebook_low is off /health there`,
      );
    }
  }

  private heldWarnings(): StartGateWarning[] {
    const { gate, store } = this.options;
    return store.getStartGateWarnings().filter((warning) => warning.gate === gate.name);
  }
}

function lowChequebook(rung: string | undefined): LowChequebook {
  return rung === undefined ? {} : { rung };
}

/** The rungs named for a log line. A single-node deployment's one node has no rung to name. */
function describeRungs(rungs: readonly (string | undefined)[]): string {
  return rungs.map((rung) => rung ?? 'its node').join(', ');
}

function seconds(ms: number): string {
  return `${ms / MS_PER_SECOND} s`;
}
