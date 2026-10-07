/**
 * Which source each part of the viewer reads from: one source for everything, or a source per part.
 * Pure, so the app keeps it in the browser and the node picker shows it.
 *
 * The video and the stream list are linked by default: the player finds a live stream's newest entry
 * from time markers at addresses computed from the clock of whoever serves the stream list, so the two
 * reading from different hosts can put the player behind or ahead of live.
 */
import { SWARM_FEATURES, type SwarmFeature } from './client';

export const ROUTING_MODES = ['one', 'per-part'] as const;

export type RoutingMode = (typeof ROUTING_MODES)[number];

/** The parts that move together while linked. */
const LINKED_PARTS: readonly SwarmFeature[] = ['player', 'stream-list'];

/** The source id each part reads from. */
export type PartSources = Readonly<Record<SwarmFeature, string>>;

export interface Routing {
  readonly mode: RoutingMode;
  /** The source of every part in {@link RoutingMode} `one`. */
  readonly source: string;
  /** Each part's own source in {@link RoutingMode} `per-part`. */
  readonly parts: PartSources;
  /** Whether the stream list reads from wherever the video does. */
  readonly linked: boolean;
}

function partsFrom(source: string): PartSources {
  return Object.fromEntries(SWARM_FEATURES.map((feature) => [feature, source])) as unknown as PartSources;
}

export function defaultRouting(defaultId: string): Routing {
  return { mode: 'one', source: defaultId, parts: partsFrom(defaultId), linked: true };
}

export function chooseSource(routing: Routing, id: string): Routing {
  return { ...routing, source: id };
}

/**
 * Per part starts from the one source in use, so switching the mode changes nothing until a part is
 * picked. One source keeps the source it had.
 */
export function setMode(routing: Routing, mode: RoutingMode): Routing {
  if (mode === routing.mode) {
    return routing;
  }
  return mode === 'per-part' ? { ...routing, mode, parts: partsFrom(routing.source) } : { ...routing, mode };
}

export function setPart(routing: Routing, feature: SwarmFeature, id: string): Routing {
  const moved = routing.linked && LINKED_PARTS.includes(feature) ? LINKED_PARTS : [feature];
  return { ...routing, parts: { ...routing.parts, ...Object.fromEntries(moved.map((part) => [part, id])) } };
}

/** Linking again moves the stream list to the video's source. */
export function setLinked(routing: Routing, linked: boolean): Routing {
  return {
    ...routing,
    linked,
    parts: linked ? { ...routing.parts, 'stream-list': routing.parts.player } : routing.parts,
  };
}

/** The routing once a source is gone: whatever read from it reads from the default. */
export function withoutSource(routing: Routing, id: string, defaultId: string): Routing {
  const replaced = (current: string) => (current === id ? defaultId : current);
  return {
    ...routing,
    source: replaced(routing.source),
    parts: Object.fromEntries(
      SWARM_FEATURES.map((feature) => [feature, replaced(routing.parts[feature])]),
    ) as unknown as PartSources,
  };
}

/**
 * The source each part reads from now. A source no longer known reads from the default gateway, so a
 * removed source or a stale saved routing never leaves a part reading from nowhere.
 */
export function resolveRouting(routing: Routing, knownIds: readonly string[], defaultId: string): PartSources {
  const known = (id: string) => (knownIds.includes(id) ? id : defaultId);
  if (routing.mode === 'one') {
    return partsFrom(known(routing.source));
  }
  const player = known(routing.parts.player);
  return {
    player,
    'stream-list': routing.linked ? player : known(routing.parts['stream-list']),
    previews: known(routing.parts.previews),
  };
}

export function serializeRouting(routing: Routing): string {
  return JSON.stringify(routing);
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * The routing a browser kept, as {@link serializeRouting} wrote it. Anything unreadable is the default,
 * and a part it cannot read keeps the default's source for that part.
 */
export function parseRouting(saved: string | null, fallback: Routing): Routing {
  if (saved === null) {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(saved);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return fallback;
  }
  const { mode, source, parts, linked } = parsed as Record<string, unknown>;
  if (!ROUTING_MODES.includes(mode as RoutingMode) || !isText(source)) {
    return fallback;
  }
  const savedParts = typeof parts === 'object' && parts !== null ? (parts as Record<string, unknown>) : {};
  return {
    mode: mode as RoutingMode,
    source,
    parts: Object.fromEntries(
      SWARM_FEATURES.map((feature) => {
        const part = savedParts[feature];
        return [feature, isText(part) ? part : fallback.parts[feature]];
      }),
    ) as unknown as PartSources,
    linked: typeof linked === 'boolean' ? linked : fallback.linked,
  };
}
