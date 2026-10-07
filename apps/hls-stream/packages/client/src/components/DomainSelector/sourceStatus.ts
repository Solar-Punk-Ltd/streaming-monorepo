/**
 * The light check behind each source's status dot in the node picker, run about every 10 s while the
 * picker is open. One request for a gateway and the provider probe for a Bee node, so it costs a viewer
 * little and never stands in for the full Test.
 */
import { Topic } from '@ethersphere/bee-js';

import { supportsLocalNetworkRequests } from '@/swarm/addressSpace';
import type { SwarmClient } from '@/swarm/client';
import { createSwarmClient } from '@/swarm/createSwarmClient';
import { PROBE_TIMEOUT_MS } from '@/swarm/provider';
import { gatewaySettingOf, type Source } from '@/swarm/sources';

import { isBlockedAsMixedContent, onlyGateway } from './gatewayProbe';

type SourceHealth = 'ok' | 'warning' | 'failing' | 'unknown';

export interface SourceStatus {
  readonly health: SourceHealth;
  /** How long the source took to answer, for one that answered. */
  readonly elapsedMs: number | null;
  /** What a warning is, in a word, where the health alone does not say. */
  readonly words?: string;
}

export const UNCHECKED: SourceStatus = { health: 'unknown', elapsedMs: null };

/** How often the node picker checks every source again while it is open. */
export const SOURCE_CHECK_INTERVAL_MS = 10_000;

interface SourceCheckContext {
  /** The stream list feed this build reads, whose head a gateway is asked for. */
  readonly catalog: { readonly owner: string; readonly topic: string };
  readonly signal?: AbortSignal;
  /** Injected by tests. Read from the page otherwise. */
  readonly pageProtocol?: string;
  /** Injected by tests. Asked of the browser otherwise. */
  readonly localNetworkRequests?: boolean;
  /** Injected by tests. The viewer's clock otherwise. */
  readonly now?: () => number;
  /** Injected by tests. A client of that source alone otherwise, with no fallback behind it. */
  readonly client?: (source: Pick<Source, 'type' | 'url'>) => Pick<SwarmClient, 'reader' | 'probe'>;
}

const failing: SourceStatus = { health: 'failing', elapsedMs: null };

const warning = (words: string): SourceStatus => ({ health: 'warning', elapsedMs: null, words });

const clientOf = (source: Pick<Source, 'type' | 'url'>) =>
  createSwarmClient(onlyGateway(gatewaySettingOf({ id: 'checked', ...source })));

function currentPageProtocol(): string {
  return typeof window === 'undefined' ? '' : window.location.protocol;
}

/**
 * Whether a source answers now. A gateway is asked for the stream list's head, the read every viewer
 * makes first, because a gateway serving only the stream's content refuses a node's health. A Bee node
 * is asked the provider probe, which also says whether it is still starting. Never rejects.
 */
export async function checkSourceStatus(
  source: Pick<Source, 'type' | 'url'>,
  context: SourceCheckContext,
): Promise<SourceStatus> {
  const now = context.now ?? (() => Date.now());
  const pageProtocol = context.pageProtocol ?? currentPageProtocol();
  const localNetworkRequests = context.localNetworkRequests ?? (await supportsLocalNetworkRequests());
  if (isBlockedAsMixedContent(source.url, pageProtocol, localNetworkRequests)) {
    return failing;
  }
  const client = (context.client ?? clientOf)(source);
  const readWindow = { timeoutMs: PROBE_TIMEOUT_MS, signal: context.signal };

  if (source.type === 'bee-node') {
    const found = await client.probe(readWindow);
    switch (found.kind) {
      case 'ok':
        return { health: 'ok', elapsedMs: found.elapsedMs };
      case 'not-ready':
        return warning('Starting');
      default:
        return context.signal?.aborted ? UNCHECKED : failing;
    }
  }

  const startedAtMs = now();
  const { owner, topic } = context.catalog;
  const answer = await client.reader('stream-list').readFeedHead(owner, Topic.fromString(topic), readWindow);
  switch (answer.kind) {
    case 'content':
    case 'not-found':
      return { health: 'ok', elapsedMs: Math.round(now() - startedAtMs) };
    case 'rate-limited':
      return warning('Busy');
    case 'unsupported':
      return warning('Limited');
    case 'unavailable':
      // An error status is a gateway that is there and not serving, which is a different next step
      // from one that does not answer at all.
      return answer.cause.kind === 'status' ? warning('Errors') : failing;
    case 'aborted':
      return UNCHECKED;
  }
}

const HEALTH_WORDS: Readonly<Record<SourceHealth, string>> = {
  ok: 'Working',
  warning: 'Not ready',
  failing: 'Not answering',
  unknown: 'Checking',
};

/** What a status dot says in words: the time a source took, or its state. */
export function sourceStatusWords(status: SourceStatus): string {
  if (status.health === 'ok' && status.elapsedMs !== null) {
    return `${status.elapsedMs} ms`;
  }
  return status.words ?? HEALTH_WORDS[status.health];
}
