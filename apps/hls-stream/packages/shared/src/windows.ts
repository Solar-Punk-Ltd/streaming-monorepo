/**
 * The window convention: a chunk at an address computed from the clock, written once at the end of
 * its window and read once after it.
 *
 * **This exists because polling a feed delays it.** Asking Bee for a chunk before it exists makes Bee
 * skip its peers for that address for about a minute, so a viewer polling the next feed index slows
 * down the very update it waits for. A window chunk is asked for only after it is due, and never again.
 *
 * Window `w` covers `[w * windowMs, (w + 1) * windowMs)` of Unix time. Its identifier is keccak256 of
 * the text `<topic>/<kind>/<windowMs>/<w>`, and its address the single owner chunk rule over that
 * identifier and the owner. For the `note` kind this is byte for byte the slot note of swarm-chat-js
 * 7.2.0 (`noteSlotOf`, `noteSlotEnd`, `noteIdentifier`, `noteAddress` and its note payload), so the
 * chat can move onto this module without a protocol change.
 *
 * Pure logic: no clock, no network. The paths are relative, because every caller holds its own
 * gateway base URL.
 */

import { EthAddress, Identifier, Reference } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';

import { HLS_EXTINF, HLS_M3U, HLS_SWARM_WRITTEN_AT } from './hlsTags.js';

/** `live` carries a quality's live playlist every window, `note` names a feed's newest index when it changes. */
export type WindowKind = 'live' | 'note';

export const LIVE_PLAYLIST_WINDOW_MS = 2000;
export const STREAM_LIST_NOTE_WINDOW_MS = 10000;
export const CHAT_NOTE_WINDOW_MS = 2000;

/** How often a `note` writer repeats its newest index with no news, so a reader opening can find one. */
export const STREAM_LIST_HEARTBEAT_MS = 60000;
export const CHAT_HEARTBEAT_MS = 30000;

/** How long after a window's end a reader first asks for it. A starting value that readers may grow. */
export const WINDOW_READ_MARGIN_MS = 1000;

/**
 * The payload of one window chunk, a hard limit. The uploader's floor rule that lets a feed playlist
 * reach 8192 bytes does not apply here, because one chunk is all a window gets.
 */
export const WINDOW_CHUNK_MAX_BYTES = 4096;

/** The chat's own limit on a note, kept so that a note this module accepts is one the chat accepts. */
export const WINDOW_NOTE_MAX_BYTES = 256;

const NOTE_VERSION = 1;
const NOTE_KEYS = ['v', 'newest', 'writtenAt'] as const;

/** One window of one topic and kind, which is everything its identifier is made of. */
export interface WindowSlot {
  readonly topic: string;
  readonly kind: WindowKind;
  readonly windowMs: number;
  readonly window: number;
}

/** The note payload: the newest feed index a writer had stored, `-1` for none yet, and when it wrote. */
export interface WindowNote {
  readonly newest: number;
  readonly writtenAt: number;
}

/** A live window's playlist exactly as the writer was given it, and when it was written. */
export interface LiveWindowPayload {
  readonly playlist: string;
  readonly writtenAt: number;
}

/**
 * A live playlist that would not fit in one window chunk.
 *
 * A class so that a writer can tell an oversized playlist, which it must shorten, from a failed upload.
 */
export class WindowChunkTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`A window chunk is at most ${WINDOW_CHUNK_MAX_BYTES} bytes, this one is ${bytes}`);
    this.name = 'WindowChunkTooLargeError';
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNoteNewest(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1;
}

function assertWindowMs(windowMs: number): void {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new RangeError(`A window length must be a positive whole number of milliseconds, got ${windowMs}`);
  }
}

function assertNonNegativeSafeInteger(what: string, value: number): void {
  if (!isNonNegativeSafeInteger(value)) {
    throw new RangeError(`${what} must be a non-negative safe integer, got ${value}`);
  }
}

/**
 * The window holding an instant, `floor(timeMs / windowMs)`.
 *
 * @throws RangeError when `windowMs` is not a positive safe integer or `timeMs` is not a non-negative
 * safe integer of Unix milliseconds.
 */
export function windowOf(timeMs: number, windowMs: number): number {
  assertWindowMs(windowMs);
  assertNonNegativeSafeInteger('A time', timeMs);
  return Math.floor(timeMs / windowMs);
}

/**
 * The first instant of a window, `window * windowMs`.
 *
 * @throws RangeError when `windowMs` is not a positive safe integer, `window` is not a non-negative
 * safe integer, or the result is past the safe integers.
 */
export function windowStart(window: number, windowMs: number): number {
  assertWindowMs(windowMs);
  assertNonNegativeSafeInteger('A window number', window);
  const start = window * windowMs;
  assertNonNegativeSafeInteger('A window start', start);
  return start;
}

/**
 * Whether a window is a heartbeat window of a `note` topic: its number is a multiple of
 * `heartbeatMs / windowMs`. A note writer writes every such window and a note reader expects every one.
 *
 * @throws RangeError when `windowMs` is not a positive safe integer, `window` is not a non-negative
 * safe integer, or `heartbeatMs` is not a positive whole multiple of `windowMs`.
 */
export function isHeartbeatWindow(window: number, windowMs: number, heartbeatMs: number): boolean {
  assertWindowMs(windowMs);
  assertNonNegativeSafeInteger('A window number', window);
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs % windowMs !== 0) {
    throw new RangeError(
      `A heartbeat must be a positive whole multiple of the ${windowMs} ms window, got ${heartbeatMs}`,
    );
  }
  return window % (heartbeatMs / windowMs) === 0;
}

/**
 * The end of a window, `(window + 1) * windowMs`, which is the first instant of the next one. A writer
 * writes the window here, and a reader asks for it here plus its margin.
 *
 * @throws RangeError on the same inputs as {@link windowStart}.
 */
export function windowEnd(window: number, windowMs: number): number {
  assertNonNegativeSafeInteger('A window number', window);
  return windowStart(window + 1, windowMs);
}

/**
 * The text a window's identifier hashes, `<topic>/<kind>/<windowMs>/<window>`, numbers in plain
 * decimal. The topic is whatever string the caller names, used as is.
 *
 * @throws RangeError when `windowMs` is not a positive safe integer or `window` is not a non-negative
 * safe integer, since either would name an address nobody writes.
 */
export function windowIdentifierText(slot: WindowSlot): string {
  assertWindowMs(slot.windowMs);
  assertNonNegativeSafeInteger('A window number', slot.window);
  return `${slot.topic}/${slot.kind}/${slot.windowMs}/${slot.window}`;
}

/** The single owner chunk identifier of a window: keccak256 of its identifier text in UTF-8. */
export function windowIdentifier(slot: WindowSlot): Identifier {
  return Identifier.fromString(windowIdentifierText(slot));
}

/** Where a window's chunk lives: keccak256 of its identifier followed by the owner's 20 bytes. */
export function windowAddress(slot: WindowSlot, owner: EthAddress | string): Reference {
  return new Reference(
    Binary.keccak256(Binary.concatBytes(windowIdentifier(slot).toUint8Array(), new EthAddress(owner).toUint8Array())),
  );
}

/**
 * The relative path that reads a window's chunk. Through `/chunks/` rather than `/soc/` because public
 * gateways serve the first and not always the second.
 */
export function windowChunkPath(slot: WindowSlot, owner: EthAddress | string): string {
  return `chunks/${windowAddress(slot, owner).toHex()}`;
}

/**
 * The note payload's bytes, `{"v":1,"newest":<n>,"writtenAt":<ms>}` in UTF-8 with the keys in that
 * order, so that two encodings of one note are the same bytes.
 *
 * @throws RangeError when `newest` is not a safe integer of at least -1 or `writtenAt` is not a
 * non-negative safe integer, which {@link parseWindowNote} would refuse.
 */
export function encodeWindowNote(note: WindowNote): Uint8Array {
  if (!isNoteNewest(note.newest)) {
    throw new RangeError(`A note's newest index must be a safe integer of at least -1, got ${note.newest}`);
  }
  assertNonNegativeSafeInteger("A note's writtenAt", note.writtenAt);
  return new TextEncoder().encode(`{"v":${NOTE_VERSION},"newest":${note.newest},"writtenAt":${note.writtenAt}}`);
}

/**
 * The note in a chunk's payload, or null for anything the chat would refuse, which a reader treats as
 * no note at all.
 *
 * Accepted: at most {@link WINDOW_NOTE_MAX_BYTES} bytes of valid UTF-8 holding a JSON object with
 * exactly the keys `v`, `newest` and `writtenAt` in any order, `v` 1, `newest` an integer from -1 to
 * 2^53 - 1 and `writtenAt` one from 0 to 2^53 - 1. Written by hand to the chat's zod schema, since this
 * package does not depend on zod.
 */
export function parseWindowNote(payload: Uint8Array): WindowNote | null {
  if (payload.length > WINDOW_NOTE_MAX_BYTES) {
    return null;
  }
  const parsed = parseJson(payload);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== NOTE_KEYS.length ||
    !NOTE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  ) {
    return null;
  }
  const { v, newest, writtenAt } = record;
  if (v !== NOTE_VERSION || !isNoteNewest(newest) || !isNonNegativeSafeInteger(writtenAt)) {
    return null;
  }
  return { newest, writtenAt };
}

/**
 * The payload as text, or null when it is not valid UTF-8. `keepBom` keeps a leading byte order mark
 * in the text, which a live payload needs so that a parse never accepts what the encoder refused.
 * Notes drop it, as the chat's decoder does.
 */
function decodeUtf8(payload: Uint8Array, keepBom = false): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: keepBom }).decode(payload);
  } catch {
    return null;
  }
}

function parseJson(payload: Uint8Array): unknown {
  const text = decodeUtf8(payload);
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** One line of a playlist: where it starts, its text without the line break, and where the next begins. */
interface PlaylistLine {
  readonly start: number;
  readonly content: string;
  readonly end: number;
}

function* playlistLines(playlist: string): Generator<PlaylistLine> {
  let start = 0;
  while (start < playlist.length) {
    const newline = playlist.indexOf('\n', start);
    const end = newline === -1 ? playlist.length : newline + 1;
    const raw = playlist.slice(start, newline === -1 ? end : newline);
    yield { start, content: raw.endsWith('\r') ? raw.slice(0, -1) : raw, end };
    start = end;
  }
}

/** The lines before a playlist's first media entry, which is where the written-at tag belongs. */
function* headerLines(playlist: string): Generator<PlaylistLine> {
  for (const line of playlistLines(playlist)) {
    if (line.content.startsWith(HLS_EXTINF)) {
      return;
    }
    yield line;
  }
}

function isWrittenAtTag(content: string): boolean {
  return content === HLS_SWARM_WRITTEN_AT || content.startsWith(`${HLS_SWARM_WRITTEN_AT}:`);
}

/**
 * A live window's payload: the playlist with `#EXT-X-SWARM-WRITTEN-AT:<writtenAt>` as its second line,
 * ended with the same line break as the `#EXTM3U` line before it.
 *
 * @throws RangeError when the playlist does not start with an `#EXTM3U` line and a line break, already
 * carries the tag, or `writtenAt` is not a non-negative safe integer.
 * @throws WindowChunkTooLargeError when the payload is over {@link WINDOW_CHUNK_MAX_BYTES} UTF-8 bytes.
 */
export function encodeLiveWindowPayload(playlist: string, writtenAt: number): Uint8Array {
  assertNonNegativeSafeInteger("A live window's writtenAt", writtenAt);
  const first = playlistLines(playlist).next();
  if (first.done === true || first.value.content !== HLS_M3U || first.value.end === playlist.length) {
    throw new RangeError(`A live window's playlist must start with an ${HLS_M3U} line followed by more`);
  }
  if ([...headerLines(playlist)].some((line) => isWrittenAtTag(line.content))) {
    throw new RangeError(`A live window's playlist already carries ${HLS_SWARM_WRITTEN_AT}`);
  }
  const afterFirst = first.value.end;
  const lineBreak = playlist.slice(HLS_M3U.length, afterFirst);
  const tagged = `${playlist.slice(0, afterFirst)}${HLS_SWARM_WRITTEN_AT}:${writtenAt}${lineBreak}${playlist.slice(afterFirst)}`;
  const payload = new TextEncoder().encode(tagged);
  if (payload.length > WINDOW_CHUNK_MAX_BYTES) {
    throw new WindowChunkTooLargeError(payload.length);
  }
  return payload;
}

/**
 * The playlist and written-at time in a live window's payload, the playlist exactly as the writer was
 * given it, or null when the payload is over {@link WINDOW_CHUNK_MAX_BYTES} bytes, is not valid UTF-8,
 * does not start with `#EXTM3U`, carries the written-at tag no times or more than once before its first
 * `#EXTINF`, or gives the tag a value that is not a non-negative safe integer in plain decimal.
 */
export function parseLiveWindowPayload(payload: Uint8Array): LiveWindowPayload | null {
  if (payload.length > WINDOW_CHUNK_MAX_BYTES) {
    return null;
  }
  const text = decodeUtf8(payload, true);
  if (text === null) {
    return null;
  }
  const first = playlistLines(text).next();
  if (first.done === true || first.value.content !== HLS_M3U) {
    return null;
  }
  const tags = [...headerLines(text)].filter((line) => isWrittenAtTag(line.content));
  const tag = tags[0];
  if (tags.length !== 1 || tag === undefined) {
    return null;
  }
  const value = tag.content.slice(HLS_SWARM_WRITTEN_AT.length + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return null;
  }
  return { playlist: text.slice(0, tag.start) + text.slice(tag.end), writtenAt: Number(value) };
}
