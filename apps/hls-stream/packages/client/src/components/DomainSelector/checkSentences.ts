/**
 * What the node picker's Test tells a viewer about each check, one plain sentence each, with the fix
 * they can make when a check fails. Kept apart from the checks so every sentence has a test of its own
 * and a new way of failing cannot ship without its words.
 */
import type { SwarmAnswer } from '@/swarm/answers';
import type { ProbeResult } from '@/swarm/provider';

/** Every way a read can end that is not the content it asked for. */
export type FailedAnswer = Exclude<SwarmAnswer, { kind: 'content' }>;

const PICK_ANOTHER = 'Test again in a minute, or pick another gateway.';

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/**
 * A browser reports a closed port, a wrong address, a node that refuses this site's origin and an address
 * a content security policy leaves out the same way, so the sentence names all of them in the order a
 * viewer can check them. The client image sets no such policy, but a proxy in front of a deployment can.
 */
export const COULD_NOT_REACH =
  "Could not reach this gateway. Check that the address is right and the node is running. If it is, this node does not allow this site: its cors-allowed-origins setting has to include it. Or this site's own policy does not allow the address, which only whoever runs the site can change.";

export const NOT_A_SWARM_GATEWAY =
  'This address is not a Swarm gateway: something answered, but not with Swarm content. Check the address and the port.';

export const MIXED_CONTENT =
  'This site is served over https, and a browser refuses to load anything over plain http from it. Give the node an https address, or open this site over http.';

/** Why a read failed and what the viewer can do about it. `what` names the content, such as "the stream list". */
export function failedReadSentence(what: string, answer: FailedAnswer): string {
  switch (answer.kind) {
    case 'not-found':
      return `This gateway answered that ${what} is not there. It may not have found it on the network yet. ${PICK_ANOTHER}`;
    case 'rate-limited':
      return 'This gateway asked to be asked less often. Wait a minute, then test again.';
    case 'unsupported':
      return `This kind of gateway cannot read ${what}. Pick another gateway for it.`;
    case 'aborted':
      return 'The test was stopped before it finished.';
    case 'unavailable':
      switch (answer.cause.kind) {
        case 'timeout':
          return `The gateway did not answer in ${seconds(answer.cause.timeoutMs)}. It may be busy or still starting. ${PICK_ANOTHER}`;
        case 'status':
          return `The gateway answered with an error (HTTP ${answer.cause.status}). ${PICK_ANOTHER}`;
        case 'network':
          return COULD_NOT_REACH;
      }
  }
}

/**
 * The connection of a gateway the build offers, which answered the Test's reads. Such a gateway serves the
 * deployment's content and nothing else, so it is not asked for a node's health, which it would refuse.
 */
export const CONNECTED_BY_CONTENT =
  "The gateway answered. It serves only the stream's content, so the Test reads that content rather than asking for the node's health.";

/** What asking the gateway whether it is there found, success included. */
export function probeSentence(result: ProbeResult, timeoutMs: number): string {
  switch (result.kind) {
    case 'ok':
      return `The gateway answered in ${result.elapsedMs} ms.`;
    case 'not-swarm':
      return NOT_A_SWARM_GATEWAY;
    case 'rejected':
      return `Something answered at this address with an error (HTTP ${result.status}). Check the address and the port.`;
    case 'timed-out':
      return `The gateway did not answer in ${seconds(timeoutMs)}. It may be busy or still starting. ${PICK_ANOTHER}`;
    case 'unreachable':
      return COULD_NOT_REACH;
  }
}

/** Why a check was not run, which is never the gateway's fault. */
export const SKIPPED = {
  noStreams: 'Not tested: the stream list has no stream to test with.',
  noPlayable: 'Not tested: no stream in the list has video yet.',
  noPicture: 'Not tested: no stream in the list has a picture.',
} as const;

/** The quoted title a sentence names a stream by. */
const titled = (title: string) => `“${title}”`;

export const PASSED = {
  streamList: (streams: number, index: number | null) =>
    `The stream list loaded: ${streams === 1 ? '1 stream' : `${streams} streams`}${index === null ? '' : `, entry ${index}`}.`,
  playerByMarker: (title: string) =>
    `The video loaded: the time marker of ${titled(title)}, a playlist and one segment.`,
  playerByEntry: (title: string) => `The video loaded: a playlist of ${titled(title)} and one segment.`,
  previews: (title: string) => `Previews loaded: the preview playlist of ${titled(title)}.`,
  picture: (title: string) => `Pictures loaded: the picture of ${titled(title)}.`,
} as const;

/** A playlist that names no segment proves the gateway answered and nothing about whether video loads. */
export const NO_SEGMENT = (title: string) =>
  `The playlist of ${titled(title)} names no segment, so no video could be loaded from it. Test again in a minute.`;
