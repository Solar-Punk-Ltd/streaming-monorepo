import type { StreamRow, UserRow } from '../types/index.js';

import { quoteForLog } from '../utils/logText.js';

/**
 * Who a mutation is done by. Every signed-in operator can act on every
 * stream, so the log line and the audit row are the only places that say
 * which of them did.
 *
 * `uploader` is the caller of the internal API: one shared bearer token, no
 * session, no name. The services it calls say so themselves rather than being
 * told by the route, so a route cannot pass an operator off as the uploader or
 * the other way round. `system` is this process acting on its own account —
 * the boot repair, the `user:add` CLI — with `reason` saying which.
 */
export type Actor =
  | { kind: 'operator'; userId: string; username: string }
  | { kind: 'uploader' }
  | { kind: 'system'; reason: string };

export type OperatorActor = Extract<Actor, { kind: 'operator' }>;

export const UPLOADER: Actor = { kind: 'uploader' };

export function operatorActor(user: UserRow): OperatorActor {
  return { kind: 'operator', userId: user.id, username: user.username };
}

/** `alice`, `the uploader`, `system (boot)`: the subject of a log line. */
export function describeActor(actor: Actor): string {
  switch (actor.kind) {
    case 'operator':
      return actor.username;
    case 'uploader':
      return 'the uploader';
    case 'system':
      return `system (${actor.reason})`;
  }
}

/**
 * `"Opening keynote" (topic 1867…)`: how a log line names a stream. The title
 * is an operator's free text, so it goes in through `quoteForLog`: a JSON
 * string, so the quotes stay, with every character a log reader could take
 * for a line break or a control escaped, a newline among them. It cannot
 * start a forged line of its own, nor reorder what the line appears to say.
 */
export function describeStream(stream: Pick<StreamRow, 'title' | 'topic'>): string {
  return `${quoteForLog(stream.title)} (topic ${stream.topic})`;
}
