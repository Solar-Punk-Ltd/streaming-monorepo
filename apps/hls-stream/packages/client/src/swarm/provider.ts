import type { Topic } from '@ethersphere/bee-js';

import type { SwarmAnswer } from './answers';

/**
 * How long a read may take, headers and body together, when its caller names no window. The same
 * ten seconds the app's own bounded fetch has always used.
 */
export const DEFAULT_READ_TIMEOUT_MS = 10_000;

/**
 * How long a probe waits for a node before calling it timed out: long enough for a cold local node,
 * short enough that a wrong port does not feel like a hang. The node picker and every provider's
 * own default use this one window.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/** What every read takes. */
export interface ReadOptions {
  /** The caller's own cancellation, for example a React effect's unmount. Ends the read as aborted. */
  readonly signal?: AbortSignal;
  /** The read's window in milliseconds. {@link DEFAULT_READ_TIMEOUT_MS} when absent. */
  readonly timeoutMs?: number;
}

/**
 * What the browser or hls.js loads by URL rather than through a read: a segment written into a
 * playlist, a segment of a stream card's preview, and a stream card's picture.
 */
export type UrlUse = 'segment' | 'preview-segment' | 'thumbnail';

/**
 * Which reads a provider can make. The client does not consult the read flags before asking: a
 * provider asked for a read it cannot make answers unsupported, and the client then asks the next one.
 * Only `urls` is read ahead, to pass over a provider that gives none.
 */
export interface ProviderCapabilities {
  readonly feedHead: boolean;
  readonly feedEntry: boolean;
  readonly soc: boolean;
  readonly chunk: boolean;
  readonly bytes: boolean;
  /** Whether {@link SwarmProvider.urlFor} gives URLs. The client takes a URL from the next provider that does. */
  readonly urls: boolean;
  /** Whether the provider runs a node inside the tab, which {@link SwarmProvider.start} starts. */
  readonly inTab: boolean;
}

/** Where a provider is in its own life. A provider over HTTP is always ready. */
export type ProviderState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface ProviderStatus {
  readonly state: ProviderState;
}

/** What asking a provider whether it is there at all found. */
export type ProbeResult =
  | { readonly kind: 'ok'; readonly elapsedMs: number }
  /** Something answered, but not as a Swarm node does. */
  | { readonly kind: 'not-swarm' }
  | { readonly kind: 'rejected'; readonly status: number }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'unreachable' };

/**
 * One way of reaching Swarm, holding only what this app reads.
 *
 * Every read resolves to a {@link SwarmAnswer} and never rejects. Owners are Ethereum addresses as
 * hex, references and chunk addresses are 32 bytes as hex, as the stream list carries them.
 */
export interface SwarmProvider {
  readonly capabilities: ProviderCapabilities;

  /** The newest entry of a feed, as the node's own lookup finds it. Slow on a feed that moves. */
  readFeedHead(owner: string, topic: Topic, options?: ReadOptions): Promise<SwarmAnswer>;

  /** One entry of a feed by its index, which is how a follower reads once it knows where it is. */
  readFeedEntry(owner: string, topic: Topic, index: number, options?: ReadOptions): Promise<SwarmAnswer>;

  /**
   * The payload of the single-owner chunk an owner wrote under an identifier, which is how the player
   * reads a ladder's time markers. The identifier is 32 bytes as hex.
   */
  readSoc(owner: string, identifier: string, options?: ReadOptions): Promise<SwarmAnswer>;

  /** One chunk by its address. Nothing in this viewer reads one today, and every provider can. */
  readChunk(address: string, options?: ReadOptions): Promise<SwarmAnswer>;

  /** The bytes a reference names, joined from its chunks. */
  readBytes(reference: string, options?: ReadOptions): Promise<SwarmAnswer>;

  /** A URL the browser or hls.js can load for a reference itself, or null when this provider gives none. */
  urlFor(reference: string, use: UrlUse): string | null;

  status(): ProviderStatus;

  /** Never rejects: every way of not being there is a result. */
  probe(options?: ReadOptions): Promise<ProbeResult>;

  /** Starts a node in the tab. Resolves at once for a provider that reaches a node elsewhere. */
  start(): Promise<void>;

  stop(): Promise<void>;
}
