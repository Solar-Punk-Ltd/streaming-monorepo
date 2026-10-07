import { describe, expect, it } from 'vitest';

import {
  chooseSource,
  defaultRouting,
  parseRouting,
  resolveRouting,
  type Routing,
  serializeRouting,
  setLinked,
  setMode,
  setPart,
  withoutSource,
} from '../../src/swarm/routing';

const KNOWN = ['event', 'backup', 'added-1'];
const DEFAULT = defaultRouting('event');

describe('the default routing', () => {
  it('reads every part from the default gateway as one source, video and stream list linked', () => {
    expect(DEFAULT).toEqual({
      mode: 'one',
      source: 'event',
      parts: { player: 'event', 'stream-list': 'event', previews: 'event' },
      linked: true,
    });
    expect(resolveRouting(DEFAULT, KNOWN, 'event')).toEqual({
      player: 'event',
      'stream-list': 'event',
      previews: 'event',
    });
  });
});

describe('one source', () => {
  it('reads the video, the stream list and the previews from the source in use', () => {
    expect(resolveRouting(chooseSource(DEFAULT, 'added-1'), KNOWN, 'event')).toEqual({
      player: 'added-1',
      'stream-list': 'added-1',
      previews: 'added-1',
    });
  });

  it('falls back to the default gateway for a source that is gone', () => {
    expect(resolveRouting(chooseSource(DEFAULT, 'added-7'), KNOWN, 'event').player).toBe('event');
  });
});

describe('per part', () => {
  const perPart = setMode(chooseSource(DEFAULT, 'backup'), 'per-part');

  it('starts from the one source in use, so switching the mode changes nothing yet', () => {
    expect(resolveRouting(perPart, KNOWN, 'event')).toEqual(
      resolveRouting(chooseSource(DEFAULT, 'backup'), KNOWN, 'event'),
    );
  });

  it('reads each part from the source it picks', () => {
    expect(resolveRouting(setPart(perPart, 'previews', 'added-1'), KNOWN, 'event')).toEqual({
      player: 'backup',
      'stream-list': 'backup',
      previews: 'added-1',
    });
  });

  it('moves the video and the stream list together while they are linked', () => {
    const routing = setPart(perPart, 'stream-list', 'added-1');

    expect(resolveRouting(routing, KNOWN, 'event')).toMatchObject({ player: 'added-1', 'stream-list': 'added-1' });
  });

  it('moves them apart once unlinked, and together again from the video when linked again', () => {
    const unlinked = setPart(setLinked(perPart, false), 'stream-list', 'added-1');
    expect(resolveRouting(unlinked, KNOWN, 'event')).toMatchObject({ player: 'backup', 'stream-list': 'added-1' });

    expect(resolveRouting(setLinked(unlinked, true), KNOWN, 'event')).toMatchObject({
      player: 'backup',
      'stream-list': 'backup',
    });
  });

  it('reads a part whose source is gone from the default gateway', () => {
    expect(resolveRouting(setPart(perPart, 'previews', 'added-7'), KNOWN, 'event')).toMatchObject({
      previews: 'event',
    });
  });

  it('goes back to one source without forgetting which that was', () => {
    expect(setMode(setPart(perPart, 'previews', 'added-1'), 'one').source).toBe('backup');
  });
});

describe('removing a source', () => {
  it('moves every part that read from it to the default gateway', () => {
    const routing = setPart(setMode(chooseSource(DEFAULT, 'added-1'), 'per-part'), 'previews', 'backup');

    expect(withoutSource(routing, 'added-1', 'event')).toEqual({
      mode: 'per-part',
      source: 'event',
      parts: { player: 'event', 'stream-list': 'event', previews: 'backup' },
      linked: true,
    });
  });
});

describe('the routing as the browser keeps it', () => {
  it('survives a round trip', () => {
    const routing: Routing = setPart(setLinked(setMode(DEFAULT, 'per-part'), false), 'stream-list', 'backup');

    expect(parseRouting(serializeRouting(routing), DEFAULT)).toEqual(routing);
  });

  it('is the default for nothing saved, for text that is not JSON, or for the wrong shape', () => {
    expect(parseRouting(null, DEFAULT)).toEqual(DEFAULT);
    expect(parseRouting('{oops', DEFAULT)).toEqual(DEFAULT);
    expect(parseRouting('{"mode":"several","source":"event"}', DEFAULT)).toEqual(DEFAULT);
    expect(parseRouting('{"mode":"one","source":7}', DEFAULT)).toEqual(DEFAULT);
  });

  it('takes the parts it can read and the default for the rest', () => {
    expect(
      parseRouting('{"mode":"per-part","source":"backup","parts":{"previews":"added-1"},"linked":false}', DEFAULT),
    ).toEqual({
      mode: 'per-part',
      source: 'backup',
      parts: { ...DEFAULT.parts, previews: 'added-1' },
      linked: false,
    });
  });
});
