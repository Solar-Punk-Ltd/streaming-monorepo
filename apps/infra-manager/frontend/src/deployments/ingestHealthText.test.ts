/**
 * What the ingest card says about a reading as a whole: the pill, and the
 * sentence it shows while nothing was read or nobody is publishing.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * The card reads SRS's reports of SRT and RTMP publishers. A broadcast over
 * RTMP must read as a broadcast, never as a missing or broken SRT link, and
 * an SRS that does not say which RTMP publishers are the broadcaster must say
 * so rather than show a number that counts the ladder's rungs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INGEST_READ,
  type IngestHealthReading,
  measuredSrtIngest,
  RTMP_INGEST_MEASURED,
  RTMP_INGEST_NO_REPORTS,
  RTMP_INGEST_UNATTRIBUTED,
  type RtmpIngestReading,
  SRT_INGEST_NO_REPORTS,
  type SrtIngestReading,
} from '@streaming-infra-manager/common';

import { type IngestHealthView, ingestHealthView } from './ingestHealthText';

const SRT_NONE: SrtIngestReading = { state: SRT_INGEST_NO_REPORTS };
const SRT_BROKEN_UP = measuredSrtIngest({
  reports: 2,
  connections: 1,
  counts: { received: 12_957, lost: 761, retransmitted: 731, dropped: 763 },
});
const SRT_CLEAN = measuredSrtIngest({
  reports: 6,
  connections: 1,
  counts: { received: 39_000, lost: 0, retransmitted: 0, dropped: 0 },
});
const RTMP_NONE: RtmpIngestReading = { state: RTMP_INGEST_NO_REPORTS };
const RTMP_SENDING: RtmpIngestReading = { state: RTMP_INGEST_MEASURED, reports: 6, connections: 1, incomingKbps: 4812 };
const RTMP_UNATTRIBUTED: RtmpIngestReading = { state: RTMP_INGEST_UNATTRIBUTED };

const readOf = (srt: SrtIngestReading, rtmp: RtmpIngestReading): IngestHealthReading => ({
  state: INGEST_READ,
  windowSeconds: 60,
  srt,
  rtmp,
});

const view = (reading: IngestHealthReading | null, loadError: string | null = null): IngestHealthView =>
  ingestHealthView({ reading, loadError }, { latencySettingOffered: false });

function allText(shown: IngestHealthView): string[] {
  return [
    shown.pill.label,
    shown.summary ?? '',
    ...[shown.srt, shown.rtmp].flatMap((part) =>
      part ? [part.summary, ...part.rows.flatMap((row) => [row.label, row.value, row.detail])] : [],
    ),
    shown.srt?.verdict ?? '',
    shown.srt?.remedy?.title ?? '',
    ...(shown.srt?.remedy?.steps.map((step) => step.text) ?? []),
  ];
}

describe('the ingest card, as a whole', () => {
  it('calls a broadcast over RTMP one, never a missing or broken SRT link', () => {
    const shown = view(readOf(SRT_NONE, RTMP_SENDING));

    assert.deepEqual(shown.pill, { label: 'Receiving over RTMP', tone: 'info' });
    assert.equal(shown.summary, null);
    assert.equal(shown.srt, null);
    assert.ok(shown.rtmp);
    for (const text of allText(shown)) assert.doesNotMatch(text, /No SRT publisher|SRT link|Bad|Degraded/, text);
  });

  it("leads with the SRT link's verdict while SRT is measured, and still shows RTMP beside it", () => {
    const shown = view(readOf(SRT_BROKEN_UP, RTMP_SENDING));

    assert.deepEqual(shown.pill, { label: 'Bad', tone: 'err' });
    assert.ok(shown.srt);
    assert.ok(shown.rtmp);
  });

  it('shows the SRT part alone for a broadcast over SRT with no RTMP publisher', () => {
    const shown = view(readOf(SRT_CLEAN, RTMP_NONE));

    assert.deepEqual(shown.pill, { label: 'Healthy', tone: 'ok' });
    assert.ok(shown.srt);
    assert.equal(shown.rtmp, null);
  });

  it('says nobody is publishing, over SRT or RTMP, rather than showing zeros', () => {
    const shown = view(readOf(SRT_NONE, RTMP_NONE));

    assert.deepEqual(shown.pill, { label: 'No publisher', tone: 'gray' });
    assert.equal(
      shown.summary,
      'SRS reported no publisher in the last 60 seconds, over SRT or RTMP. It reports each publisher about every ten seconds while it sends, so nobody is publishing, or a publisher connected moments ago.',
    );
    assert.equal(shown.srt, null);
    assert.equal(shown.rtmp, null);
  });

  it('says RTMP is not measured on an SRS that does not name the vhost, rather than that nobody publishes', () => {
    const shown = view(readOf(SRT_NONE, RTMP_UNATTRIBUTED));

    assert.deepEqual(shown.pill, { label: 'RTMP not measured', tone: 'gray' });
    assert.equal(shown.summary, null);
    assert.ok(shown.rtmp);
  });

  it('keeps the SRT verdict on the pill beside an SRS that does not name the vhost', () => {
    assert.deepEqual(view(readOf(SRT_CLEAN, RTMP_UNATTRIBUTED)).pill, { label: 'Healthy', tone: 'ok' });
  });
});

describe('the ingest card with no log to read', () => {
  it('says SRS is not running', () => {
    const shown = view({ state: 'not_running', windowSeconds: 60 });

    assert.deepEqual(shown.pill, { label: 'SRS not running', tone: 'gray' });
    assert.equal(shown.summary, 'SRS is not running, so there is no ingest to read.');
    assert.equal(shown.srt, null);
    assert.equal(shown.rtmp, null);
  });

  it('says the log could not be read, and that the page will ask again', () => {
    const shown = view({ state: 'unreadable', windowSeconds: 60 });

    assert.deepEqual(shown.pill, { label: 'Not read', tone: 'gray' });
    assert.equal(shown.summary, "The manager could not read SRS's log just now. The page asks again in a few seconds.");
  });

  it('says only SRS reports these, for a deployment on another engine', () => {
    const shown = view({ state: 'not_srs', windowSeconds: 60 });

    assert.deepEqual(shown.pill, { label: 'Not SRS', tone: 'gray' });
    assert.equal(shown.summary, 'This deployment does not run SRS, and only SRS reports these statistics.');
  });

  it('says it is reading until the first answer arrives', () => {
    const shown = view(null);

    assert.deepEqual(shown.pill, { label: 'Reading', tone: 'info' });
    assert.equal(shown.summary, "Reading SRS's statistics.");
  });

  it('says the manager could not be asked, with its reason', () => {
    const shown = view(null, 'request failed (502)');

    assert.deepEqual(shown.pill, { label: 'Not read', tone: 'gray' });
    assert.equal(shown.summary, 'Could not ask the manager. request failed (502)');
  });
});

describe('the words on the card', () => {
  it('carry no em dash and no semicolon, in any state', () => {
    const views = [
      view(readOf(SRT_BROKEN_UP, RTMP_SENDING)),
      view(readOf(SRT_CLEAN, RTMP_UNATTRIBUTED)),
      view(readOf(SRT_NONE, RTMP_SENDING)),
      view(readOf(SRT_NONE, { ...RTMP_SENDING, incomingKbps: null } as RtmpIngestReading)),
      view(readOf(SRT_NONE, RTMP_NONE)),
      ...(['not_running', 'unreadable', 'not_srs'] as const).map((state) => view({ state, windowSeconds: 60 })),
      view(null),
      view(null, 'request failed (502)'),
      ingestHealthView({ reading: readOf(SRT_BROKEN_UP, RTMP_NONE), loadError: null }, { latencySettingOffered: true }),
    ];

    for (const text of views.flatMap(allText)) {
      assert.ok(!text.includes('\u2014'), `an em dash in: ${text}`);
      assert.ok(!text.includes(';'), `a semicolon in: ${text}`);
    }
  });
});
