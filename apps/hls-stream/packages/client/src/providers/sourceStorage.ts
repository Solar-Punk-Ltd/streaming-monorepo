/**
 * Where a viewer's sources, routing and order of fallbacks survive a reload: this browser's
 * localStorage, one key each. A browser can refuse the page its storage, in a private window or with
 * site data blocked, so every read and write is guarded, and a refusal means the build's defaults
 * for this visit rather than a page that fails.
 */
import { parseFallbackOrder, serializeFallbackOrder } from '@/swarm/fallbackOrder';
import { defaultRouting, parseRouting, type Routing, serializeRouting, chooseSource } from '@/swarm/routing';
import type { SwarmSettings } from '@/swarm/settings';
import { type AddedSource, migratedSources, parseAddedSources, serializeAddedSources } from '@/swarm/sources';

/**
 * Where the node picker kept the one address a viewer chose before sources existed.
 *
 * Exported because the arm harness seeds it before the app runs, which is the only way an arm can be
 * on its own gateway for the join rather than from the first render onwards. The first load moves it
 * into a source. `e2e` mirrors the string and `e2e/test/gatewaySweep.test.ts` reads this line to prove
 * the two still agree.
 */
export const GATEWAY_STORAGE_KEY = 'swarm-gateway-url';

export const SOURCE_STORAGE_KEYS = {
  sources: 'swarm-sources',
  routing: 'swarm-routing',
  fallbackOrder: 'swarm-fallback-order',
  /** The one address the node picker saved, read once to move it into a source. */
  legacyAddress: GATEWAY_STORAGE_KEY,
} as const;

/** What of the browser's storage this needs, so a test can hand it one in memory. */
export type SourceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SourceChoices {
  readonly added: readonly AddedSource[];
  readonly routing: Routing;
  /** The viewer's own order of fallbacks, or null to take the build's. */
  readonly fallbackOrder: readonly string[] | null;
}

function browserStorage(): SourceStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(storage: SourceStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: SourceStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // The choice holds for this visit and is not remembered.
  }
}

function remove(storage: SourceStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Left for the next visit, which reads the new keys first and never moves it twice.
  }
}

/**
 * What the viewer chose before. A browser holding only the address saved before sources existed has it
 * moved into a source once: its sources and routing are written under the new keys and the old key is
 * removed, so the move is not made again over a choice made since.
 */
export function loadSourceChoices(
  settings: SwarmSettings,
  storage: SourceStorage | null = browserStorage(),
): SourceChoices {
  const initial = defaultRouting(settings.defaultId);
  const savedSources = read(storage, SOURCE_STORAGE_KEYS.sources);
  const savedRouting = read(storage, SOURCE_STORAGE_KEYS.routing);
  const fallbackOrder = parseFallbackOrder(read(storage, SOURCE_STORAGE_KEYS.fallbackOrder));

  if (savedSources === null && savedRouting === null) {
    const migrated = migratedSources(settings, read(storage, SOURCE_STORAGE_KEYS.legacyAddress));
    if (migrated !== null) {
      const routing = chooseSource(initial, migrated.chosenId);
      saveAddedSources(migrated.added, storage);
      saveRouting(routing, storage);
      remove(storage, SOURCE_STORAGE_KEYS.legacyAddress);
      return { added: migrated.added, routing, fallbackOrder };
    }
  }
  return {
    added: parseAddedSources(savedSources),
    routing: parseRouting(savedRouting, initial),
    fallbackOrder,
  };
}

export function saveAddedSources(added: readonly AddedSource[], storage = browserStorage()): void {
  write(storage, SOURCE_STORAGE_KEYS.sources, serializeAddedSources(added));
}

export function saveRouting(routing: Routing, storage = browserStorage()): void {
  write(storage, SOURCE_STORAGE_KEYS.routing, serializeRouting(routing));
}

export function saveFallbackOrder(order: readonly string[], storage = browserStorage()): void {
  write(storage, SOURCE_STORAGE_KEYS.fallbackOrder, serializeFallbackOrder(order));
}
