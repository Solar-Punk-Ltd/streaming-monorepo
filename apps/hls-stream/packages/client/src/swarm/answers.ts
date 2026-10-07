/**
 * What every read of Swarm ends as. A provider never throws for a read: the network failing, a node
 * refusing, the caller giving up and the content not being there are all answers, so a feature
 * decides what each one means rather than sorting exceptions.
 */

/** The content was served. */
export interface ContentAnswer {
  readonly kind: 'content';
  readonly bytes: Uint8Array;
  /**
   * The feed index the node resolved the read to, from Bee's `swarm-feed-index` header, which is
   * zero-padded hexadecimal. Null where the answer carries none, which is every read but a feed head.
   */
  readonly feedIndex: number | null;
  /** The instant the answer's `Date` header names, in Unix milliseconds, or null without one. */
  readonly serverTimeMs: number | null;
}

/** The node answered that nothing is there. An answer about the content, never a fault of the node. */
export interface NotFoundAnswer {
  readonly kind: 'not-found';
  readonly serverTimeMs: number | null;
}

/** The node asked to be asked less often. */
export interface RateLimitedAnswer {
  readonly kind: 'rate-limited';
  /** How long the node asked to be left alone, from `Retry-After`, or null when it did not say. */
  readonly retryAfterMs: number | null;
  readonly serverTimeMs: number | null;
}

/** This provider cannot make this kind of read at all, so asking again will not help. */
export interface UnsupportedAnswer {
  readonly kind: 'unsupported';
}

/** Why a provider could not answer. */
export type UnavailableCause =
  /** Nothing came back inside the read's window, headers and body together. */
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  /** The node answered with a status that is neither content nor one of the answers above. */
  | { readonly kind: 'status'; readonly status: number }
  /** The request never got an answer: a closed port, a DNS miss, or a browser refusing it. */
  | { readonly kind: 'network'; readonly error: unknown };

/** A fault: the provider could not say whether the content is there. */
export interface UnavailableAnswer {
  readonly kind: 'unavailable';
  readonly cause: UnavailableCause;
}

/** The caller's own signal stopped the read. */
export interface AbortedAnswer {
  readonly kind: 'aborted';
}

export type SwarmAnswer =
  | ContentAnswer
  | NotFoundAnswer
  | RateLimitedAnswer
  | UnsupportedAnswer
  | UnavailableAnswer
  | AbortedAnswer;

export type AnswerKind = SwarmAnswer['kind'];

export const ANSWER_KINDS: readonly AnswerKind[] = [
  'content',
  'not-found',
  'rate-limited',
  'unsupported',
  'unavailable',
  'aborted',
];

export const UNSUPPORTED: UnsupportedAnswer = { kind: 'unsupported' };

export const ABORTED: AbortedAnswer = { kind: 'aborted' };

/** The server time an answer carries, for the answers that came from a node at all. */
export function serverTimeOf(answer: SwarmAnswer): number | null {
  return 'serverTimeMs' in answer ? answer.serverTimeMs : null;
}

const UTF8 = new TextDecoder();

/** A content answer's bytes as UTF-8 text, which is how playlists and the stream list are read. */
export function contentText(answer: ContentAnswer): string {
  return UTF8.decode(answer.bytes);
}
