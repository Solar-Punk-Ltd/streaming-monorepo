import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { viewerCatalogEntrySchema, viewerCatalogRungSchema } from '@swarm-hls-stream/shared';

import { isRendition, isStream } from './helpers/catalogReaderBeforeContract';

/**
 * The contract's schemas accept exactly the catalog entries and rungs the viewer's own readers accepted.
 *
 * Measured, not argued: every field of a valid entry and of a valid rung is swapped for every value in a palette of
 * what a JSON feed can carry, and both readings must agree on each.
 */

const PALETTE: unknown[] = [
  undefined,
  null,
  '',
  ' ',
  '0',
  '3',
  '42.5',
  'abc',
  'live',
  'vod',
  'scheduled',
  'video',
  'audio',
  'image',
  [],
  [3],
  ['a'],
  {},
  { value: 3 },
  true,
  false,
  0,
  -0,
  1,
  3.5,
  -1,
  1e21,
  Infinity,
  -Infinity,
  Number.NaN,
];

const RUNG = {
  name: '720p',
  width: 1280,
  height: 720,
  topic: 'rung-topic',
  bandwidth: 2_800_000,
  avgBandwidth: 2_500_000,
};
const ENTRY = { owner: '0xowner', topic: 'topic', title: 'A broadcast', timestamp: 1, mediatype: 'video' };
const OPTIONAL_FIELDS = ['state', 'duration', 'index', 'thumbnail', 'scheduledStartTime', 'renditions', 'group'];

function variations(base: Record<string, unknown>, extraFields: string[]): unknown[] {
  const found: unknown[] = [base, { ...base, unknown: 1 }, null, [], 'text', 3, [base]];
  for (const field of [...Object.keys(base), ...extraFields]) {
    for (const value of PALETTE) found.push({ ...base, [field]: value });
  }
  return found;
}

const label = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry === undefined ? '<undefined>' : typeof entry === 'number' && !Number.isFinite(entry) ? String(entry) : entry,
  );

describe("the contract reads the catalog as the viewer's own readers did", () => {
  it('a rung', () => {
    const inputs = variations(RUNG, ['index', 'duration']);
    let accepted = 0;
    for (const input of inputs) {
      const before = isRendition(input);
      assert.equal(viewerCatalogRungSchema.safeParse(input).success, before, label(input));
      if (before) accepted += 1;
    }
    assert.ok(accepted > 5 && accepted < inputs.length - 5, `${accepted} of ${inputs.length}`);
  });

  it('an entry, its rungs included', () => {
    const inputs = [
      ...variations(ENTRY, OPTIONAL_FIELDS),
      ...variations(RUNG, ['index', 'duration']).map((rung) => ({ ...ENTRY, renditions: [RUNG, rung] })),
    ];
    let accepted = 0;
    for (const input of inputs) {
      const before = isStream(input);
      const after = viewerCatalogEntrySchema.safeParse(input);
      assert.equal(after.success, before, label(input));
      if (before) {
        assert.deepEqual(after.data, input, `kept whole ${label(input)}`);
        accepted += 1;
      }
    }
    assert.ok(accepted > 10 && accepted < inputs.length - 10, `${accepted} of ${inputs.length}`);
  });
});
