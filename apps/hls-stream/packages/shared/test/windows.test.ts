import { EthAddress } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HLS_SWARM_WRITTEN_AT } from '../src/hlsTags.js';
import {
  CHAT_HEARTBEAT_MS,
  CHAT_NOTE_WINDOW_MS,
  encodeLiveWindowPayload,
  encodeWindowNote,
  LIVE_PLAYLIST_WINDOW_MS,
  parseLiveWindowPayload,
  parseWindowNote,
  STREAM_LIST_HEARTBEAT_MS,
  STREAM_LIST_NOTE_WINDOW_MS,
  WINDOW_CHUNK_MAX_BYTES,
  WINDOW_NOTE_MAX_BYTES,
  WINDOW_READ_MARGIN_MS,
  WindowChunkTooLargeError,
  type WindowKind,
  windowAddress,
  windowChunkPath,
  windowEnd,
  windowIdentifier,
  windowIdentifierText,
  windowOf,
  windowStart,
} from '../src/windows.js';

const OWNER_A = '1234567890abcdef1234567890abcdef12345678';
const OWNER_B = 'ff'.repeat(20);

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('window arithmetic', () => {
  it('puts the first instant of a window in that window and the instant before it in the one before', () => {
    assert.equal(windowOf(7 * 2000, 2000), 7);
    assert.equal(windowOf(7 * 2000 - 1, 2000), 6);
    assert.equal(windowOf(0, 2000), 0);
  });

  it("ends each window at the next window's start", () => {
    assert.equal(windowStart(7, 2000), 14000);
    assert.equal(windowEnd(7, 2000), windowStart(8, 2000));
  });

  it('refuses a window length that is not a positive whole number of milliseconds', () => {
    for (const bad of [0, -2000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => windowOf(1000, bad), RangeError, `windowMs ${bad}`);
      assert.throws(() => windowStart(1, bad), RangeError, `windowMs ${bad}`);
      assert.throws(() => windowEnd(1, bad), RangeError, `windowMs ${bad}`);
    }
  });

  it('refuses a time or a window number that is not a non-negative safe integer', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => windowOf(bad, 2000), RangeError, `time ${bad}`);
      assert.throws(() => windowStart(bad, 2000), RangeError, `window ${bad}`);
      assert.throws(() => windowEnd(bad, 2000), RangeError, `window ${bad}`);
    }
  });

  it('refuses a window whose end is past the safe integers', () => {
    assert.throws(() => windowEnd(Number.MAX_SAFE_INTEGER, 2000), RangeError);
  });
});

describe("the plan's worked example, 2026-11-04 12:00:05.300 UTC", () => {
  const now = Date.UTC(2026, 10, 4, 12, 0, 5, 300);

  it('is the instant the plan names', () => {
    assert.equal(now, 1793793605300);
  });

  it('is in stream list window 179379360, and 179379359 is the newest finished one', () => {
    assert.equal(windowOf(now, STREAM_LIST_NOTE_WINDOW_MS), 179379360);
    assert.equal(windowEnd(179379359, STREAM_LIST_NOTE_WINDOW_MS), 1793793600000);
  });

  it('is in live window 896896802, and 896896801 is first asked at 12:00:05.000 with the margin', () => {
    assert.equal(windowOf(now, LIVE_PLAYLIST_WINDOW_MS), 896896802);
    assert.equal(windowEnd(896896801, LIVE_PLAYLIST_WINDOW_MS), 1793793604000);
    assert.equal(windowEnd(896896801, LIVE_PLAYLIST_WINDOW_MS) + WINDOW_READ_MARGIN_MS, 1793793605000);
  });
});

describe('named lengths', () => {
  it('match the plan', () => {
    assert.equal(LIVE_PLAYLIST_WINDOW_MS, 2000);
    assert.equal(STREAM_LIST_NOTE_WINDOW_MS, 10000);
    assert.equal(CHAT_NOTE_WINDOW_MS, 2000);
    assert.equal(STREAM_LIST_HEARTBEAT_MS, 60000);
    assert.equal(CHAT_HEARTBEAT_MS, 30000);
    assert.equal(WINDOW_READ_MARGIN_MS, 1000);
    assert.equal(WINDOW_CHUNK_MAX_BYTES, 4096);
    assert.equal(WINDOW_NOTE_MAX_BYTES, 256);
  });
});

describe('identifier text', () => {
  it('is topic, kind, window length and window number, joined by slashes', () => {
    assert.equal(
      windowIdentifierText({ topic: 'stage-1-1080p', kind: 'live', windowMs: 2000, window: 896896801 }),
      'stage-1-1080p/live/2000/896896801',
    );
    assert.equal(
      windowIdentifierText({ topic: 'event-streams', kind: 'note', windowMs: 10000, window: 179379359 }),
      'event-streams/note/10000/179379359',
    );
  });

  it('writes the largest safe window number in plain decimal', () => {
    assert.equal(
      windowIdentifierText({ topic: 't', kind: 'note', windowMs: 2000, window: 4503599627370495 }),
      't/note/2000/4503599627370495',
    );
  });

  it('refuses a bad window length or window number', () => {
    assert.throws(() => windowIdentifierText({ topic: 't', kind: 'note', windowMs: 0, window: 1 }), RangeError);
    assert.throws(() => windowIdentifierText({ topic: 't', kind: 'note', windowMs: 2000, window: -1 }), RangeError);
  });
});

/**
 * 16-hex prefixes of the identifier and the address for each kind.
 *
 * The `note` columns are what swarm-chat-js 7.2.0's own `noteIdentifier` and `noteAddress` returned
 * for these inputs, run by the orchestrating session on 2026-10-06. The `live` columns come from an
 * independent keccak over the same text rule, which also agreed with the chat's helpers on every
 * `note` row. Prefixes rather than whole values because a whole 64-hex value cannot be written into
 * a file on the machine these tests are written on.
 */
const CHAT_LIBRARY_VECTORS: ReadonlyArray<{
  topic: string;
  windowMs: number;
  window: number;
  owner: string;
  prefixes: Record<WindowKind, { identifier: string; address: string }>;
}> = [
  {
    topic: 'stage-1-1080p',
    windowMs: 2000,
    window: 896896801,
    owner: OWNER_A,
    prefixes: {
      note: { identifier: '74c701dbf0bc761c', address: 'cd11af1e9bd26e4b' },
      live: { identifier: '0dbe683f55657159', address: 'fd7d42f95748b412' },
    },
  },
  {
    topic: 'event-streams',
    windowMs: 10000,
    window: 179379359,
    owner: OWNER_A,
    prefixes: {
      note: { identifier: '16e5c855d6be060e', address: '6dbed17fbabbf2d8' },
      live: { identifier: 'a98d374c39c675d7', address: '15902aeac4337548' },
    },
  },
  {
    topic: 'cd97ee21-968f-5b33-9542-000000000001',
    windowMs: 2000,
    window: 0,
    owner: OWNER_B,
    prefixes: {
      note: { identifier: '74bd4dae6ebc7757', address: '0cead92ff54fc823' },
      live: { identifier: '7a43db6fef2d5679', address: 'f5f9d7d769d15de2' },
    },
  },
  {
    topic: 'chat-üñï',
    windowMs: 2000,
    window: 4503599627370495,
    owner: OWNER_B,
    prefixes: {
      note: { identifier: 'fc46e4c0640985c0', address: '3c561c579693524f' },
      live: { identifier: 'd1dd4675d8bb4de5', address: '9060908f4f166ee7' },
    },
  },
];

describe('identifier and address, against swarm-chat-js 7.2.0', () => {
  for (const vector of CHAT_LIBRARY_VECTORS) {
    for (const kind of ['note', 'live'] as const) {
      const slot = { topic: vector.topic, kind, windowMs: vector.windowMs, window: vector.window };
      const label = `${kind} of ${vector.topic} window ${vector.window}`;

      it(`computes the identifier of the ${label}`, () => {
        assert.equal(windowIdentifier(slot).toHex().slice(0, 16), vector.prefixes[kind].identifier);
      });

      it(`computes the address of the ${label}`, () => {
        assert.equal(windowAddress(slot, vector.owner).toHex().slice(0, 16), vector.prefixes[kind].address);
      });
    }
  }

  it('takes the owner as a string or as an EthAddress', () => {
    const slot = { topic: 'stage-1-1080p', kind: 'note', windowMs: 2000, window: 896896801 } as const;
    assert.equal(windowAddress(slot, new EthAddress(OWNER_A)).toHex(), windowAddress(slot, OWNER_A).toHex());
  });

  it('reads a window through the chunks endpoint, relative to the caller base', () => {
    const slot = { topic: 'stage-1-1080p', kind: 'live', windowMs: 2000, window: 896896801 } as const;
    const path = windowChunkPath(slot, OWNER_A);
    assert.equal(path, `chunks/${windowAddress(slot, OWNER_A).toHex()}`);
    assert.ok(path.startsWith('chunks/fd7d42f95748b412'));
  });
});

describe('note payload, byte-identical to swarm-chat-js 7.2.0', () => {
  /** A valid note padded with JSON whitespace to exactly `bytes` long. */
  function noteOfLength(bytes: number): Uint8Array {
    const note = '{"v":1,"newest":1,"writtenAt":5}';
    return utf8(`${note}${' '.repeat(bytes - note.length)}`);
  }

  it('encodes the keys in a fixed order', () => {
    assert.equal(
      text(encodeWindowNote({ newest: 214, writtenAt: 1793793600012 })),
      '{"v":1,"newest":214,"writtenAt":1793793600012}',
    );
  });

  it('round-trips', () => {
    assert.deepEqual(parseWindowNote(encodeWindowNote({ newest: 214, writtenAt: 1793793600012 })), {
      newest: 214,
      writtenAt: 1793793600012,
    });
  });

  it('refuses to encode a note the parser would reject', () => {
    assert.throws(() => encodeWindowNote({ newest: -2, writtenAt: 0 }), RangeError);
    assert.throws(() => encodeWindowNote({ newest: 1.5, writtenAt: 0 }), RangeError);
    assert.throws(() => encodeWindowNote({ newest: 0, writtenAt: -1 }), RangeError);
  });

  it('accepts newest -1 and the keys in another order', () => {
    assert.deepEqual(parseWindowNote(utf8('{"newest":-1,"writtenAt":5,"v":1}')), { newest: -1, writtenAt: 5 });
  });

  const rejected: Record<string, Uint8Array> = {
    'an extra key': utf8('{"v":1,"newest":1,"writtenAt":5,"x":0}'),
    'a missing key': utf8('{"v":1,"newest":1}'),
    'v 2': utf8('{"v":2,"newest":1,"writtenAt":5}'),
    'a non-integer newest': utf8('{"v":1,"newest":1.5,"writtenAt":5}'),
    'a string newest': utf8('{"v":1,"newest":"1","writtenAt":5}'),
    'newest -2': utf8('{"v":1,"newest":-2,"writtenAt":5}'),
    'newest past the safe integers': utf8('{"v":1,"newest":9007199254740992,"writtenAt":5}'),
    'a negative writtenAt': utf8('{"v":1,"newest":1,"writtenAt":-1}'),
    '257 bytes': noteOfLength(257),
    'invalid UTF-8': new Uint8Array([0x7b, 0xff, 0x7d]),
    'an array': utf8('[1,2,3]'),
    null: utf8('null'),
    'text that is not JSON': utf8('not json'),
  };

  for (const [name, bytes] of Object.entries(rejected)) {
    it(`returns null for ${name}`, () => {
      assert.equal(parseWindowNote(bytes), null);
    });
  }

  it('accepts exactly 256 bytes', () => {
    const padded = noteOfLength(256);
    assert.equal(padded.length, 256);
    assert.deepEqual(parseWindowNote(padded), { newest: 1, writtenAt: 5 });
    assert.equal(rejected['257 bytes']?.length, 257);
  });
});

describe('live payload', () => {
  const PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:70',
    '#EXTINF:2.000,',
    'ab'.repeat(32),
    '',
  ].join('\n');

  it('puts the written-at tag on the second line', () => {
    const lines = text(encodeLiveWindowPayload(PLAYLIST, 1793793604010)).split('\n');
    assert.equal(lines[0], '#EXTM3U');
    assert.equal(lines[1], `${HLS_SWARM_WRITTEN_AT}:1793793604010`);
    assert.equal(lines[2], '#EXT-X-VERSION:3');
  });

  it('round-trips exactly, trailing newline included', () => {
    assert.deepEqual(parseLiveWindowPayload(encodeLiveWindowPayload(PLAYLIST, 1793793604010)), {
      playlist: PLAYLIST,
      writtenAt: 1793793604010,
    });
    const noTrailingNewline = PLAYLIST.slice(0, -1);
    assert.equal(parseLiveWindowPayload(encodeLiveWindowPayload(noTrailingNewline, 0))?.playlist, noTrailingNewline);
  });

  it('round-trips a playlist with CRLF line ends', () => {
    const crlf = PLAYLIST.split('\n').join('\r\n');
    assert.deepEqual(parseLiveWindowPayload(encodeLiveWindowPayload(crlf, 7)), { playlist: crlf, writtenAt: 7 });
  });

  /** A playlist whose encoding is exactly `bytes` long, padded with a two-byte character. */
  function playlistEncodingTo(bytes: number): string {
    const head = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#`;
    const overhead = utf8(head).length + utf8(`${HLS_SWARM_WRITTEN_AT}:7\n`).length + 1;
    const room = bytes - overhead;
    return `${head}${'é'.repeat(Math.floor(room / 2))}${'x'.repeat(room % 2)}\n`;
  }

  it('accepts exactly 4096 bytes and refuses 4097, counting a multi-byte character as its bytes', () => {
    const fits = encodeLiveWindowPayload(playlistEncodingTo(4096), 7);
    assert.equal(fits.length, 4096);
    assert.notEqual(parseLiveWindowPayload(fits), null);

    assert.throws(() => encodeLiveWindowPayload(playlistEncodingTo(4097), 7), WindowChunkTooLargeError);
  });

  it('refuses to encode a playlist that does not start with #EXTM3U or already carries the tag', () => {
    assert.throws(() => encodeLiveWindowPayload('#EXT-X-VERSION:3\n', 7), RangeError);
    assert.throws(() => encodeLiveWindowPayload('#EXTM3U', 7), RangeError);
    assert.throws(() => encodeLiveWindowPayload(`#EXTM3U\n${HLS_SWARM_WRITTEN_AT}:1\n`, 7), RangeError);
    assert.throws(() => encodeLiveWindowPayload(PLAYLIST, -1), RangeError);
    assert.throws(() => encodeLiveWindowPayload(PLAYLIST, 1.5), RangeError);
  });

  const tagged = (value: string): string => `#EXTM3U\n${HLS_SWARM_WRITTEN_AT}:${value}\n#EXTINF:2.000,\nseg\n`;

  const rejected: Record<string, Uint8Array> = {
    'more than 4096 bytes': utf8(tagged('7') + '#'.repeat(4097)),
    'invalid UTF-8': Uint8Array.of(...utf8(tagged('7')), 0xff),
    'a first line other than #EXTM3U': utf8(`#EXT-X-VERSION:3\n${HLS_SWARM_WRITTEN_AT}:7\n`),
    'no tag': utf8('#EXTM3U\n#EXTINF:2.000,\nseg\n'),
    'the tag only after the first #EXTINF': utf8(`#EXTM3U\n#EXTINF:2.000,\n${HLS_SWARM_WRITTEN_AT}:7\nseg\n`),
    'the tag twice': utf8(`#EXTM3U\n${HLS_SWARM_WRITTEN_AT}:7\n${HLS_SWARM_WRITTEN_AT}:8\n#EXTINF:2.000,\nseg\n`),
    'a negative value': utf8(tagged('-1')),
    'a fractional value': utf8(tagged('1.5')),
    'an empty value': utf8(tagged('')),
    'a value past the safe integers': utf8(tagged('9007199254740992')),
    'a value with text after it': utf8(tagged('7ms')),
  };

  for (const [name, bytes] of Object.entries(rejected)) {
    it(`returns null for ${name}`, () => {
      assert.equal(parseLiveWindowPayload(bytes), null);
    });
  }

  it('finds the tag anywhere before the first #EXTINF', () => {
    const later = `#EXTM3U\n#EXT-X-VERSION:3\n${HLS_SWARM_WRITTEN_AT}:9\n#EXTINF:2.000,\nseg\n`;
    assert.deepEqual(parseLiveWindowPayload(utf8(later)), {
      playlist: '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.000,\nseg\n',
      writtenAt: 9,
    });
  });
});
