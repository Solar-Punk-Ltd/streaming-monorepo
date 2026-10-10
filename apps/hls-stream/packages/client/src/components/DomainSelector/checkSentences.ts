/**
 * What the node picker's Test tells a viewer about each check, one plain sentence each, with the fix
 * they can make when a check fails. Kept apart from the checks so every sentence has a test of its own
 * and a new way of failing cannot ship without its words.
 */
import type { SwarmAnswer } from '@/swarm/answers';
import type { NotReadyReason, ProbeResult } from '@/swarm/provider';

import type { UnreachableCause } from './reachability';

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
  'This site is served over https, and a browser refuses to load anything over plain http from it, so the request never leaves this page. Give the node an https address, or open this site over http.';

/**
 * A plain http node on the local network, from an https page, in a browser that blocks it before any
 * request leaves the page.
 */
export const LOCAL_HTTP_UNSUPPORTED =
  "This browser does not let a site served over https reach a plain http node on your local network. Open this page in Chrome or Edge, or enter the node's https address.";

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
    case 'not-ready':
      return notReadySentence(result.reason);
    case 'rejected':
      return `Something answered at this address with an error (HTTP ${result.status}). Check the address and the port.`;
    case 'timed-out':
      return `The gateway did not answer in ${seconds(timeoutMs)}. It may be busy or still starting. ${PICK_ANOTHER}`;
    case 'refuses-this-site':
      return UNREACHABLE_SENTENCES['cors-refused'];
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

/** A Bee node that answers and cannot serve this viewer yet, each with what to do about it. */
export const NODE_NOT_READY = {
  starting: 'The Bee node at this address is still starting. Wait a minute, then try again.',
  noPeers:
    'The Bee node at this address is running but has no peers yet, so it cannot fetch anything from Swarm. Wait a minute for it to connect, then try again.',
  tooOld: (version: string, needed: string) =>
    `This Bee node runs version ${version}, and this viewer needs ${needed} or newer. Update the node, then try again.`,
} as const;

/** What the picker and the Test say about a node that answered and cannot serve this viewer yet. */
export function notReadySentence(reason: NotReadyReason): string {
  switch (reason.kind) {
    case 'starting':
      return NODE_NOT_READY.starting;
    case 'no-peers':
      return NODE_NOT_READY.noPeers;
    case 'too-old':
      return NODE_NOT_READY.tooOld(reason.version, reason.needed);
  }
}

/** One step of help: what it is, then the exact text to copy or the thing to do. */
interface HelpStep {
  readonly label: string;
  readonly code?: string;
  readonly text?: string;
}

/** Help shown under a failure, when the fix takes more than one sentence. */
export interface Help {
  readonly intro: string;
  readonly steps: readonly HelpStep[];
  readonly note: string;
}

/**
 * How to let this site read from a Bee node, for the origin the page is served from, which the caller
 * reads from the page at run time. Bee takes `cors-allowed-origins` as a list in its config file, a
 * flag on the command line, or `BEE_CORS_ALLOWED_ORIGINS` in its environment.
 */
export function corsHelp(origin: string): Help {
  return {
    intro:
      "Add this site to the node's cors-allowed-origins setting, then restart the node. If the setting already lists other sites, add this one to the list.",
    steps: [
      { label: "In the node's config file, often bee.yaml:", code: `cors-allowed-origins: ["${origin}"]` },
      { label: 'Or on the command line:', code: `bee start --cors-allowed-origins=${origin}` },
      { label: 'Or as an environment variable:', code: `BEE_CORS_ALLOWED_ORIGINS=${origin}` },
    ],
    note: "Swarm Desktop writes cors-allowed-origins: '*' into its own config.yaml, which allows every site. If your Swarm Desktop node refuses this site, put that line back and restart Swarm Desktop.",
  };
}

/** How to undo a refusal of the browser's local network question, in the browsers that ask it. */
export const LOCAL_NETWORK_HELP: Help = {
  intro:
    'The first time a site reaches a device on your network or a program on this computer, your browser asks whether to allow it. A Block is remembered for this site. To undo it:',
  steps: [
    {
      label: 'Chrome:',
      text: 'Click the icon to the left of the address, open Site settings, and set Local network access to Allow.',
    },
    {
      label: 'Edge:',
      text: 'Open Settings, then Privacy, search, and services, Site permissions, All permissions, Local network access, and allow this site.',
    },
    {
      label: 'Firefox:',
      text: 'Open Settings, then Privacy & Security, Permissions, and allow this site under Local network devices, or under Device apps and services for a node on this computer.',
    },
  ],
  note: 'Then reload this page and try again.',
};

/** Why a node of the viewer's own could not be reached, as far as the page can tell. */
export const UNREACHABLE_SENTENCES: Readonly<Record<UnreachableCause['kind'], string>> = {
  unreachable:
    'Nothing answers at this address. Check that the node is running and that the address and port are right. The Bee API is usually on port 1633.',
  'cors-refused':
    "Something answers at this address, but it does not let this site read from it. If it is your Bee node, add this site to the node's cors-allowed-origins setting, then restart the node.",
  'local-network-refused':
    'Your browser is blocking this site from reaching your local network and this computer, so the request never reached the node.',
  'unreachable-local':
    'Nothing answered at this address. Check that the node is running and the port is right. If your browser asked whether this site may reach devices on your local network, the answer has to be Allow.',
};

export function unreachableSentence(cause: UnreachableCause): string {
  return UNREACHABLE_SENTENCES[cause.kind];
}

/** The help a cause needs beyond its sentence, or null when the sentence says it all. */
export function unreachableHelp(cause: UnreachableCause, origin: string): Help | null {
  switch (cause.kind) {
    case 'cors-refused':
      return corsHelp(origin);
    case 'local-network-refused':
    case 'unreachable-local':
      return LOCAL_NETWORK_HELP;
    case 'unreachable':
      return null;
  }
}
