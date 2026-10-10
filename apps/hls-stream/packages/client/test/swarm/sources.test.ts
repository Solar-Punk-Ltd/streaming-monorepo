import { describe, expect, it } from 'vitest';

import { parseProvidersSetting, swarmSettingsFrom } from '../../src/swarm/settings';
import {
  addSource,
  allSources,
  gatewaySettingOf,
  migratedSources,
  parseAddedSources,
  removeSource,
  renameSource,
  serializeAddedSources,
  sourceName,
  type AddedSource,
} from '../../src/swarm/sources';

const EVENT = 'https://event.example.com';
const BACKUP = 'https://backup.example.com';

function settings() {
  return swarmSettingsFrom({
    beeUrl: '/bee',
    providers: parseProvidersSetting(
      JSON.stringify({
        gateways: [
          { id: 'event', kind: 'bee-http', url: EVENT },
          { id: 'backup', kind: 'bee-http', label: 'Backup gateway', url: BACKUP },
        ],
        default: 'event',
      }),
    ),
  });
}

const NODE: AddedSource = { id: 'added-1', type: 'bee-node', name: 'Desk node', url: 'http://localhost:1633' };

describe('the sources', () => {
  it('are the gateways the build offers, marked offered and named, then the ones the viewer added', () => {
    expect(allSources(settings(), [NODE])).toEqual([
      { id: 'event', type: 'gateway', name: 'Default gateway', url: EVENT, offered: true },
      { id: 'backup', type: 'gateway', name: 'Backup gateway', url: BACKUP, offered: true },
      { ...NODE, offered: false },
    ]);
  });

  it('are each read through the provider kind of their type', () => {
    expect(gatewaySettingOf({ ...NODE, offered: false })).toEqual({
      id: 'added-1',
      kind: 'bee-http',
      url: 'http://localhost:1633',
    });
  });

  it('name an id they do not hold by what it is, never by an address', () => {
    expect(sourceName(allSources(settings(), [NODE]), 'added-1')).toBe('Desk node');
    expect(sourceName(allSources(settings(), []), 'added-9')).toBe('A removed source');
  });
});

describe('adding, renaming and removing a source', () => {
  it('adds any number of each type, each under an id of its own', () => {
    const one = addSource([], { type: 'gateway', name: ' My gateway ', url: 'https://gw.example.com' });
    const two = addSource(one.sources, { type: 'gateway', name: 'Second', url: 'https://gw2.example.com' });
    const three = addSource(two.sources, NODE);

    expect(three.sources.map(({ id, type, name }) => [id, type, name])).toEqual([
      ['added-1', 'gateway', 'My gateway'],
      ['added-2', 'gateway', 'Second'],
      ['added-3', 'bee-node', 'Desk node'],
    ]);
    expect([one.id, two.id, three.id]).toEqual(['added-1', 'added-2', 'added-3']);
  });

  it('never gives a new source the id of one removed before it', () => {
    const two = addSource(addSource([], NODE).sources, NODE).sources;
    const afterRemoval = removeSource(two, 'added-1');

    expect(addSource(afterRemoval, NODE).id).toBe('added-3');
  });

  it('renames an added source, and keeps the old name for a blank one', () => {
    const added = [NODE];

    expect(renameSource(added, 'added-1', '  Laptop  ')[0].name).toBe('Laptop');
    expect(renameSource(added, 'added-1', '   ')[0].name).toBe('Desk node');
  });

  it('cuts a long name to what a row shows', () => {
    expect(renameSource([NODE], 'added-1', 'x'.repeat(100))[0].name).toHaveLength(40);
  });

  it('removes only the source named', () => {
    const two = [NODE, { ...NODE, id: 'added-2' }];

    expect(removeSource(two, 'added-1').map(({ id }) => id)).toEqual(['added-2']);
  });
});

describe('the added sources as the browser keeps them', () => {
  it('survive a round trip', () => {
    expect(parseAddedSources(serializeAddedSources([NODE]))).toEqual([NODE]);
  });

  it('are none for nothing saved, for text that is not JSON, and for anything but a list', () => {
    expect(parseAddedSources(null)).toEqual([]);
    expect(parseAddedSources('{oops')).toEqual([]);
    expect(parseAddedSources('{"id":"added-1"}')).toEqual([]);
  });

  it('leave out an entry of the wrong shape, of an unknown type, or under an id already used', () => {
    const saved = JSON.stringify([
      NODE,
      { ...NODE, id: 'added-1' },
      { ...NODE, id: 'added-2', type: 'freedom' },
      { ...NODE, id: 'added-3', url: 42 },
      { ...NODE, id: 'event' },
      { ...NODE, id: 'added-4', name: '' },
      'added-5',
    ]);

    expect(parseAddedSources(saved)).toEqual([NODE]);
  });
});

describe('moving a choice saved before sources existed', () => {
  it('turns an address no gateway has into an added Bee node, in use', () => {
    expect(migratedSources(settings(), 'http://localhost:1633/')).toEqual({
      added: [{ id: 'added-1', type: 'bee-node', name: 'My Bee node', url: 'http://localhost:1633' }],
      chosenId: 'added-1',
    });
  });

  it('turns the address of an offered gateway into a choice of that gateway, adding nothing', () => {
    expect(migratedSources(settings(), `${BACKUP}/`)).toEqual({ added: [], chosenId: 'backup' });
  });

  it('moves nothing when nothing was saved', () => {
    expect(migratedSources(settings(), null)).toBeNull();
    expect(migratedSources(settings(), '')).toBeNull();
  });
});
