/**
 * The sources a viewer reads Swarm from: the gateways the build offers, and the gateways and Bee nodes
 * the viewer added, any number of each. Pure, so the app keeps them in the browser and the node picker
 * shows them, and neither holds a rule of its own about them.
 */
import type { ProviderKindName } from './providerKinds';
import { choiceForAddress, gatewayName, type GatewaySetting, type SwarmSettings } from './settings';

/** What a viewer adds a source as. */
export const SOURCE_TYPES = ['gateway', 'bee-node'] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/** The provider kind each type of source is read through. Both are Bee's HTTP API today. */
export const SOURCE_TYPE_KIND: Readonly<Record<SourceType, ProviderKindName>> = {
  gateway: 'bee-http',
  'bee-node': 'bee-http',
};

/** A source the viewer added, as the browser keeps it. */
export interface AddedSource {
  readonly id: string;
  readonly type: SourceType;
  readonly name: string;
  readonly url: string;
}

export interface Source extends AddedSource {
  /** Offered by the build, so it cannot be renamed or removed. */
  readonly offered: boolean;
}

export type NewSource = Omit<AddedSource, 'id'>;

/**
 * Every added source's id starts with this, so an id saved in the browser cannot be read as a gateway
 * the build offers.
 */
const ADDED_ID_PREFIX = 'added-';

/** As long as a row shows without cutting it on a phone. */
export const SOURCE_NAME_MAX_LENGTH = 40;

/** What a viewer's own node saved before sources existed is called once it is one. */
const MIGRATED_NODE_NAME = 'My Bee node';

const isAddedId = (id: string) => id.startsWith(ADDED_ID_PREFIX);

/** A name as a viewer typed it, trimmed and cut to {@link SOURCE_NAME_MAX_LENGTH}, or null for a blank one. */
export function cleanSourceName(input: string): string | null {
  const name = input.trim().replace(/\s+/g, ' ').slice(0, SOURCE_NAME_MAX_LENGTH).trim();
  return name === '' ? null : name;
}

/** The build's gateways first, in its order, then the viewer's in the order they were added. */
export function allSources(settings: SwarmSettings, added: readonly AddedSource[]): Source[] {
  return [
    ...settings.gateways.map((gateway): Source => ({
      id: gateway.id,
      type: 'gateway',
      name: gatewayName(settings, gateway.id),
      url: gateway.url,
      offered: true,
    })),
    ...added.map((source): Source => ({ ...source, offered: false })),
  ];
}

/** What a source is shown as wherever its id turns up, such as the report, which names and never addresses. */
export function sourceName(sources: readonly Source[], id: string): string {
  return sources.find((source) => source.id === id)?.name ?? 'A removed source';
}

/** The settings the Swarm client makes a source's provider from. */
export function gatewaySettingOf(source: Pick<Source, 'id' | 'type' | 'url'>): GatewaySetting {
  return { id: source.id, kind: SOURCE_TYPE_KIND[source.type], url: source.url };
}

function nextAddedId(added: readonly AddedSource[]): string {
  const highest = Math.max(0, ...added.map(({ id }) => Number(id.slice(ADDED_ID_PREFIX.length)) || 0));
  return `${ADDED_ID_PREFIX}${highest + 1}`;
}

/** The sources with one more, and its id. A blank name is the type's own name. */
export function addSource(
  added: readonly AddedSource[],
  source: NewSource,
): { readonly sources: AddedSource[]; readonly id: string } {
  const id = nextAddedId(added);
  const name = cleanSourceName(source.name) ?? (source.type === 'gateway' ? 'Gateway' : 'Bee node');
  return { sources: [...added, { id, type: source.type, name, url: source.url }], id };
}

/** The sources with one renamed. A blank name keeps the one it had. */
export function renameSource(added: readonly AddedSource[], id: string, name: string): AddedSource[] {
  const cleaned = cleanSourceName(name);
  return added.map((source) => (source.id === id && cleaned !== null ? { ...source, name: cleaned } : source));
}

export function removeSource(added: readonly AddedSource[], id: string): AddedSource[] {
  return added.filter((source) => source.id !== id);
}

export function serializeAddedSources(added: readonly AddedSource[]): string {
  return JSON.stringify(added);
}

function isAddedSource(value: unknown): value is AddedSource {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { id, type, name, url } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    isAddedId(id) &&
    SOURCE_TYPES.includes(type as SourceType) &&
    typeof name === 'string' &&
    cleanSourceName(name) !== null &&
    typeof url === 'string' &&
    url !== ''
  );
}

/**
 * The added sources a browser kept, as {@link serializeAddedSources} wrote them. Anything else, such as
 * an entry another build wrote or a hand edit, is left out rather than trusted.
 */
export function parseAddedSources(saved: string | null): AddedSource[] {
  if (saved === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(saved);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const seen = new Set<string>();
  const sources: AddedSource[] = [];
  for (const entry of parsed) {
    if (isAddedSource(entry) && !seen.has(entry.id)) {
      seen.add(entry.id);
      sources.push({ id: entry.id, type: entry.type, name: entry.name, url: entry.url });
    }
  }
  return sources;
}

/**
 * What a choice saved before sources existed becomes. That choice was one address: an offered gateway's
 * is a choice of that gateway, and any other was a Bee node of the viewer's own, which becomes an added
 * Bee node in use, so a viewer keeps reading where they read before.
 */
export function migratedSources(
  settings: SwarmSettings,
  savedAddress: string | null,
): { readonly added: AddedSource[]; readonly chosenId: string } | null {
  if (!savedAddress) {
    return null;
  }
  const choice = choiceForAddress(settings, savedAddress);
  if (settings.gateways.some((gateway) => gateway.id === choice.id)) {
    return { added: [], chosenId: choice.id };
  }
  const { sources, id } = addSource([], { type: 'bee-node', name: MIGRATED_NODE_NAME, url: choice.url });
  return { added: sources, chosenId: id };
}
