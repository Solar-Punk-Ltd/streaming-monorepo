import { describe, expect, it } from 'vitest';

import {
  loadSourceChoices,
  saveAddedSources,
  saveFallbackOrder,
  saveRouting,
  SOURCE_STORAGE_KEYS,
} from '../src/providers/sourceStorage';
import { defaultRouting, setMode } from '../src/swarm/routing';
import { parseProvidersSetting, swarmSettingsFrom } from '../src/swarm/settings';

const EVENT = 'https://event.example.com';
const BACKUP = 'https://backup.example.com';

function settings() {
  return swarmSettingsFrom({
    beeUrl: '/bee',
    providers: parseProvidersSetting(
      JSON.stringify({
        gateways: [
          { id: 'event', kind: 'bee-http', url: EVENT },
          { id: 'backup', kind: 'bee-http', url: BACKUP },
        ],
        default: 'event',
        fallback: 'backup',
      }),
    ),
  });
}

/** A browser's storage in memory. */
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

/** A browser that refuses the page its storage, as a private window or blocked site data can. */
const refusing = {
  getItem: (): string | null => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  removeItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
};

describe("the viewer's sources in the browser", () => {
  it("are none added, the default routing and the build's order when nothing is saved", () => {
    expect(loadSourceChoices(settings(), memory())).toEqual({
      added: [],
      routing: defaultRouting('event'),
      fallbackOrder: null,
    });
  });

  it('are what was saved under each key', () => {
    const storage = memory();
    const node = { id: 'added-1', type: 'bee-node' as const, name: 'Desk node', url: 'http://localhost:1633' };
    const routing = setMode(defaultRouting('event'), 'per-part');
    saveAddedSources([node], storage);
    saveRouting(routing, storage);
    saveFallbackOrder(['backup', 'event'], storage);

    expect([...storage.values.keys()].sort()).toEqual(
      [SOURCE_STORAGE_KEYS.sources, SOURCE_STORAGE_KEYS.routing, SOURCE_STORAGE_KEYS.fallbackOrder].sort(),
    );
    expect(loadSourceChoices(settings(), storage)).toEqual({
      added: [node],
      routing,
      fallbackOrder: ['backup', 'event'],
    });
  });

  it('move a node saved before sources existed into an added source in use, and forget the old key', () => {
    const storage = memory({ [SOURCE_STORAGE_KEYS.legacyAddress]: 'http://localhost:1633' });

    const loaded = loadSourceChoices(settings(), storage);

    expect(loaded.added).toEqual([
      { id: 'added-1', type: 'bee-node', name: 'My Bee node', url: 'http://localhost:1633' },
    ]);
    expect(loaded.routing.source).toBe('added-1');
    expect(storage.values.has(SOURCE_STORAGE_KEYS.legacyAddress)).toBe(false);
    expect(loadSourceChoices(settings(), storage)).toEqual(loaded);
  });

  it('move an offered gateway saved before sources existed into a choice of it', () => {
    const storage = memory({ [SOURCE_STORAGE_KEYS.legacyAddress]: BACKUP });

    expect(loadSourceChoices(settings(), storage)).toMatchObject({ added: [], routing: { source: 'backup' } });
  });

  it('leave the old key alone once the new ones exist', () => {
    const storage = memory({ [SOURCE_STORAGE_KEYS.legacyAddress]: BACKUP });
    saveRouting(defaultRouting('event'), storage);

    expect(loadSourceChoices(settings(), storage).routing.source).toBe('event');
  });

  it('are the defaults, and saving does nothing, when the browser refuses its storage', () => {
    expect(loadSourceChoices(settings(), refusing)).toEqual({
      added: [],
      routing: defaultRouting('event'),
      fallbackOrder: null,
    });
    expect(() => saveRouting(defaultRouting('event'), refusing)).not.toThrow();
    expect(() => saveAddedSources([], refusing)).not.toThrow();
    expect(() => saveFallbackOrder([], refusing)).not.toThrow();
  });
});
