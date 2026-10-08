import { Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  encodeLadderMarker,
  ladderMarkerIdentifier,
  type LadderMarker,
  MARKER_PERIOD_SECONDS,
  markerPeriodAt,
  markerPeriodStartMs,
  parseLadderMarker,
} from '../src/ladderMarker.js';

const RUNG_360 = 'a'.repeat(64);
const RUNG_720 = '0123456789abcdef'.repeat(4);

/**
 * Identifiers computed with `@noble/hashes`' keccak_256 over the bytes the convention names, outside
 * this package's own code: the group string hashed to its feed topic, then
 * `keccak256("ladder-marker" ‖ topic ‖ period as u64 big-endian)`. Frozen, so a change to the layout
 * cannot be agreed with by the same arithmetic that made it.
 *
 * Only the first 64 bits of each hash are kept. The machine's secret guard refuses a full 32-byte hex
 * literal in any file, and 64 bits is far more than enough to tell one byte layout from another.
 */
const VECTORS = [
  {
    group: 'ladder-marker-vector-group',
    period: 0,
    topicPrefix: '0d5e5bb0926a65e5',
    identifierPrefix: 'f6b46271eff0479d',
  },
  {
    group: 'ladder-marker-vector-group',
    period: 175_983_840,
    topicPrefix: '0d5e5bb0926a65e5',
    identifierPrefix: 'a2f6848ee95311e3',
  },
  {
    // Past 32 bits, so a writer that packed the period into four bytes, or little-endian, disagrees here.
    group: '3f2b8c4e-1d2a-4b6f-9e0a-7c5d4e3f2a1b',
    period: 1_099_511_627_781,
    topicPrefix: '3ee91f4778abbdde',
    identifierPrefix: '3359b2fcd770d32e',
  },
];

function validMarker(overrides: Partial<LadderMarker> = {}): LadderMarker {
  return {
    v: 2,
    period: 175_983_840,
    writtenAt: 1_759_838_400_250,
    rungs: { [RUNG_360]: 41, [RUNG_720]: 0 },
    segmentMs: 2_000,
    ...overrides,
  };
}

/** A marker as the uploader wrote them before they named a segment length. */
function versionOneText(): string {
  const { segmentMs: _segmentMs, ...rest } = validMarker();
  return JSON.stringify({ ...rest, v: 1 });
}

describe('ladder marker period', () => {
  it('is ten seconds of global time, counted from the epoch rather than from any stream', () => {
    assert.equal(MARKER_PERIOD_SECONDS, 10);
    assert.equal(markerPeriodAt(0), 0);
    assert.equal(markerPeriodAt(9_999), 0);
    assert.equal(markerPeriodAt(10_000), 1);
    assert.equal(markerPeriodAt(1_759_838_405_123), 175_983_840);
  });

  it('starts each period on its boundary', () => {
    assert.equal(markerPeriodStartMs(175_983_840), 1_759_838_400_000);
    assert.equal(markerPeriodAt(markerPeriodStartMs(175_983_840)), 175_983_840);
  });
});

describe('ladderMarkerIdentifier', () => {
  for (const vector of VECTORS) {
    it(`matches the frozen vector for period ${vector.period}`, () => {
      const topic = Topic.fromString(vector.group);
      assert.ok(topic.toHex().startsWith(vector.topicPrefix), 'the group hashes to the topic the vector used');
      const identifier = ladderMarkerIdentifier(topic, vector.period).toHex();
      assert.equal(identifier.length, 64);
      assert.equal(identifier.slice(0, vector.identifierPrefix.length), vector.identifierPrefix);
    });
  }

  it('refuses a period that is not a whole non-negative number', () => {
    const topic = Topic.fromString('ladder-marker-vector-group');
    assert.throws(() => ladderMarkerIdentifier(topic, -1), RangeError);
    assert.throws(() => ladderMarkerIdentifier(topic, 1.5), RangeError);
    assert.throws(() => ladderMarkerIdentifier(topic, Number.MAX_SAFE_INTEGER + 1), RangeError);
  });
});

describe('encodeLadderMarker and parseLadderMarker', () => {
  it('round-trips a valid marker', () => {
    const marker = validMarker();
    const text = new TextDecoder().decode(encodeLadderMarker(marker));
    assert.deepEqual(parseLadderMarker(text), marker);
    assert.deepEqual(parseLadderMarker(text, marker.period), marker);
  });

  it('names the segment length the stage cuts, so a reader can move a head on before it has a playlist', () => {
    const text = new TextDecoder().decode(encodeLadderMarker(validMarker({ segmentMs: 500 })));
    assert.equal(JSON.parse(text).segmentMs, 500);
    assert.equal(parseLadderMarker(text)?.segmentMs, 500);
  });

  it('still reads a version 1 marker, which names no segment length', () => {
    const marker = parseLadderMarker(versionOneText());
    assert.notEqual(marker, null);
    assert.equal(marker?.v, 1);
    assert.equal(marker?.segmentMs, null);
  });

  it('refuses to encode a marker that names no segment length', () => {
    assert.throws(() => encodeLadderMarker(validMarker({ segmentMs: null })));
    assert.throws(() => encodeLadderMarker(JSON.parse(versionOneText()) as LadderMarker));
  });

  it('refuses to encode a marker larger than one chunk', () => {
    const rungs = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [i.toString(16).padStart(64, '0'), Number.MAX_SAFE_INTEGER]),
    );
    assert.throws(() => encodeLadderMarker(validMarker({ rungs })), /4096 byte chunk/);
  });

  it('refuses to encode a marker its own parser would reject', () => {
    assert.throws(() => encodeLadderMarker(validMarker({ rungs: {} })));
  });

  const rejected: Array<[string, string]> = [
    ['text that is not JSON', '{"v":1,'],
    ['an array', '[]'],
    ['null', 'null'],
    ['another version', JSON.stringify(validMarker({ v: 3 as 2 }))],
    ['a version 2 marker without a segment length', JSON.stringify({ ...validMarker(), segmentMs: undefined })],
    ['a version 1 marker with a segment length', JSON.stringify(validMarker({ v: 1 }))],
    ['a segment length of zero', JSON.stringify(validMarker({ segmentMs: 0 }))],
    ['a fractional segment length', JSON.stringify(validMarker({ segmentMs: 500.5 }))],
    ['a segment length written as a string', JSON.stringify({ ...validMarker(), segmentMs: '500' })],
    ['a missing field', JSON.stringify({ v: 1, period: 1, rungs: { [RUNG_360]: 1 } })],
    ['an extra field', JSON.stringify({ ...validMarker(), note: 'x' })],
    ['a negative period', JSON.stringify(validMarker({ period: -1 }))],
    ['a fractional period', JSON.stringify(validMarker({ period: 1.5 }))],
    ['a period written as a string', JSON.stringify({ ...validMarker(), period: '175983840' })],
    ['a write time outside its own period', JSON.stringify(validMarker({ writtenAt: 1_759_838_410_000 }))],
    ['a write time before its own period', JSON.stringify(validMarker({ writtenAt: 1_759_838_399_999 }))],
    ['no rungs at all', JSON.stringify(validMarker({ rungs: {} }))],
    ['rungs as an array', JSON.stringify({ ...validMarker(), rungs: [1, 2] })],
    ['an uppercase rung topic', JSON.stringify(validMarker({ rungs: { [RUNG_360.toUpperCase()]: 1 } }))],
    ['a short rung topic', JSON.stringify(validMarker({ rungs: { abcd: 1 } }))],
    ['a negative index', JSON.stringify(validMarker({ rungs: { [RUNG_360]: -1 } }))],
    ['a fractional index', JSON.stringify(validMarker({ rungs: { [RUNG_360]: 0.5 } }))],
    ['an index past the safe integers', JSON.stringify(validMarker({ rungs: { [RUNG_360]: 2 ** 53 } }))],
  ];

  for (const [what, text] of rejected) {
    it(`rejects ${what}`, () => {
      assert.equal(parseLadderMarker(text), null);
    });
  }

  it('rejects a marker for another period than the one the reader asked for', () => {
    const text = JSON.stringify(validMarker());
    assert.equal(parseLadderMarker(text, 175_983_841), null);
  });
});
