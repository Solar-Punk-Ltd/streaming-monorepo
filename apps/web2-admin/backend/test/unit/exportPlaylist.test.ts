import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { broadcastDay, exportFileName, slugTitle } from '../../src/domain/export/names.js';
import { parseRecordingPlaylist, runsOf, segmentReference } from '../../src/domain/export/playlist.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);

describe('reading a recording playlist', () => {
  it('takes the reference from each of the three forms a segment is named in', () => {
    assert.equal(segmentReference(A), A);
    assert.equal(segmentReference(`http://10.0.0.5:1633/bytes/${B}`), B);
    assert.equal(segmentReference(`/bytes/${C.toUpperCase()}`), C);
    assert.equal(segmentReference(`${A}${B}`), `${A}${B}`);
    assert.equal(segmentReference('https://example.test/video.ts'), null);
  });

  it('skips gap entries, keeps seams on the segment after them, and adds up the length', () => {
    const playlist = parseRecordingPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXTINF:2.000,',
        A,
        '#EXT-X-GAP',
        '#EXTINF:2.000,',
        'gap-1',
        '#EXTINF:1.500,',
        `http://old-host:1633/bytes/${B}`,
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:2.000,',
        C,
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    assert.deepEqual(playlist.segments, [
      { reference: A, durationSeconds: 2, discontinuity: false },
      { reference: B, durationSeconds: 1.5, discontinuity: false },
      { reference: C, durationSeconds: 2, discontinuity: true },
    ]);
    assert.equal(playlist.gaps, 1);
    assert.equal(playlist.durationSeconds, 5.5);
  });

  it('refuses a playlist that is not a finished recording, or names something that is not a reference', () => {
    assert.throws(() => parseRecordingPlaylist('not a playlist'), /not an HLS playlist/);
    assert.throws(() => parseRecordingPlaylist(`#EXTM3U\n#EXTINF:2,\n${A}\n`), /no end/);
    assert.throws(
      () => parseRecordingPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n1080p.m3u8\n#EXT-X-ENDLIST'),
      /master playlist/,
    );
    assert.throws(
      () => parseRecordingPlaylist('#EXTM3U\n#EXTINF:2,\nhttp://attacker.test/x.ts\n#EXT-X-ENDLIST'),
      /not a Swarm reference/,
    );
  });

  it('splits the segments into runs at a seam and at a segment that was not read', () => {
    const segments = [
      { reference: A, durationSeconds: 2, discontinuity: false },
      { reference: B, durationSeconds: 2, discontinuity: false },
      { reference: C, durationSeconds: 2, discontinuity: false },
      { reference: D, durationSeconds: 2, discontinuity: true },
    ];
    const names = (runs: ReturnType<typeof runsOf>) => runs.map((run) => run.map((segment) => segment.reference[0]));
    assert.deepEqual(names(runsOf(segments, new Set([A, B, C, D]))), [['a', 'b', 'c'], ['d']]);
    assert.deepEqual(names(runsOf(segments, new Set([A, C, D]))), [['a'], ['c'], ['d']]);
    assert.deepEqual(names(runsOf(segments, new Set())), []);
  });
});

describe('naming an exported file', () => {
  it('names it by title, day and quality', () => {
    assert.equal(
      exportFileName({ title: 'Opening Keynote', day: '2026-11-05', quality: '1080p', partial: false }),
      'opening-keynote-2026-11-05-1080p.mp4',
    );
    assert.equal(
      exportFileName({ title: 'Opening Keynote', day: '2026-11-05', quality: '720p', partial: true }),
      'opening-keynote-2026-11-05-720p-partial.mp4',
    );
  });

  it('keeps the title to plain letters and digits, and cuts a long one at a word', () => {
    assert.equal(slugTitle('Weekly News @ Example Con 8: Day 2'), 'weekly-news-example-con-8-day-2');
    assert.equal(slugTitle('Café Ünïcode — “quotes”'), 'cafe-unicode-quotes');
    assert.equal(slugTitle('🎥🎬'), 'stream');
    const long = slugTitle(`${'word '.repeat(30)}end`);
    assert.ok(long.length <= 80);
    assert.ok(long.endsWith('word'));
  });

  it('dates it by the day the broadcast started, in UTC, then the schedule, then the end', () => {
    const at = (iso: string) => new Date(iso);
    assert.equal(
      broadcastDay({
        live_since: at('2026-11-04T23:30:00.000Z'),
        scheduled_start_time: at('2026-11-06T09:00:00.000Z'),
        ended_at: null,
      }),
      '2026-11-04',
    );
    assert.equal(
      broadcastDay({ live_since: null, scheduled_start_time: at('2026-11-06T09:00:00.000Z'), ended_at: null }),
      '2026-11-06',
    );
    assert.equal(broadcastDay({ live_since: null, scheduled_start_time: null, ended_at: null }), null);
  });
});
