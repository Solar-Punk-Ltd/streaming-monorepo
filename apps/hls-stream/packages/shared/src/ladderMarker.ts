/**
 * Where every quality of a ladder stood, written once every ten seconds at an address a viewer can
 * compute from the clock.
 *
 * Each rung's playlist feed is a numbered sequence, and a viewer that starts or switches has to find
 * the newest number. Bee's own lookup walks at most 255 indexes a round from 0, so on a long broadcast
 * that is many round trips. The uploader instead writes one small single-owner chunk per period,
 * owned by the ladder's signer, naming the newest published index of every rung. A viewer computes the
 * address of a recent period, reads it once, and is then at most one short round of reads from the
 * head. A missing or malformed marker only means the viewer searches as it did before.
 *
 * One definition here, because the uploader writes it and every reader computes the same address.
 */

import { Identifier, Topic } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';

export const MARKER_PERIOD_SECONDS = 10;

const MARKER_PERIOD_MS = MARKER_PERIOD_SECONDS * 1000;

export const LADDER_MARKER_VERSION = 1;

/** One Swarm chunk's payload. A marker that does not fit would need a second chunk and a second read. */
export const LADDER_MARKER_MAX_BYTES = 4096;

const IDENTIFIER_PREFIX = new TextEncoder().encode('ladder-marker');

/** A rung's feed topic as bee-js prints it: 32 bytes, lowercase hex, no prefix. */
const RUNG_TOPIC_HEX = /^[0-9a-f]{64}$/;

const MARKER_FIELDS = ['period', 'rungs', 'v', 'writtenAt'];

/**
 * What one marker says.
 *
 * `rungs` maps each rung's feed topic, as {@link Topic.toHex} prints it, to the newest index that rung
 * had published when the marker was written. A rung that has never published is absent.
 */
export interface LadderMarker {
  v: typeof LADDER_MARKER_VERSION;
  period: number;
  /** Unix milliseconds, inside the marker's own period. */
  writtenAt: number;
  rungs: Record<string, number>;
}

/** The period a wall-clock instant falls in. Global time, so every reader agrees without knowing the stream. */
export function markerPeriodAt(unixMs: number): number {
  return Math.floor(unixMs / MARKER_PERIOD_MS);
}

export function markerPeriodStartMs(period: number): number {
  return period * MARKER_PERIOD_MS;
}

/**
 * The single-owner chunk identifier of the marker for one ladder and one period:
 * `keccak256("ladder-marker" ‖ group topic ‖ period as 8 bytes big-endian)`.
 *
 * `group` is the ladder's master feed topic, `Topic.fromString(group id)`, so a reader holding the
 * master's address already holds everything this needs.
 */
export function ladderMarkerIdentifier(group: Topic, period: number): Identifier {
  if (!isWholeNumber(period)) {
    throw new RangeError(`A marker period is a whole non-negative number, not ${period}`);
  }
  const periodBytes = new Uint8Array(8);
  new DataView(periodBytes.buffer).setBigUint64(0, BigInt(period), false);
  return new Identifier(Binary.keccak256(Binary.concatBytes(IDENTIFIER_PREFIX, group.toUint8Array(), periodBytes)));
}

/** The chunk payload for a marker, refused when a reader would reject it or it would not fit one chunk. */
export function encodeLadderMarker(marker: LadderMarker): Uint8Array {
  const text = JSON.stringify(marker);
  if (parseLadderMarker(text, marker.period) === null) {
    throw new Error(`Refusing to write a ladder marker no reader would accept: ${text}`);
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > LADDER_MARKER_MAX_BYTES) {
    throw new Error(`A ladder marker of ${bytes.length} bytes does not fit one ${LADDER_MARKER_MAX_BYTES} byte chunk`);
  }
  return bytes;
}

/**
 * A marker, or null for anything that is not exactly one.
 *
 * Strict on purpose. A reader acts on these numbers by jumping straight to a feed slot, so a marker
 * with an extra field, a stray type or a write time outside its own period is treated as absent and
 * the reader searches instead. `expectedPeriod` is the period the reader computed the address from.
 */
export function parseLadderMarker(text: string, expectedPeriod?: number): LadderMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  if (Object.keys(value).sort().join(',') !== MARKER_FIELDS.join(',')) {
    return null;
  }

  const { v, period, writtenAt, rungs } = value;
  if (v !== LADDER_MARKER_VERSION || !isWholeNumber(period) || !isWholeNumber(writtenAt)) {
    return null;
  }
  if (expectedPeriod !== undefined && period !== expectedPeriod) {
    return null;
  }
  if (markerPeriodAt(writtenAt) !== period) {
    return null;
  }
  if (!isPlainObject(rungs)) {
    return null;
  }
  const entries = Object.entries(rungs);
  if (entries.length === 0) {
    return null;
  }
  for (const [topic, index] of entries) {
    if (!RUNG_TOPIC_HEX.test(topic) || !isWholeNumber(index)) {
      return null;
    }
  }

  return { v, period, writtenAt, rungs: Object.fromEntries(entries) as Record<string, number> };
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
