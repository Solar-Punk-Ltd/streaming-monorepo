/**
 * The words the ingest card's RTMP part turns a reading into.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * SRS reports each RTMP publisher's incoming bitrate about every ten seconds,
 * by a 30-second average it has none of for a new connection. The ladder's
 * rungs are RTMP publishers too, and an SRS that does not name the vhost of
 * each cannot tell them from the broadcaster.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INGEST_READ,
  RTMP_INGEST_MEASURED,
  RTMP_INGEST_UNATTRIBUTED,
  type RtmpIngestReading,
  SRT_INGEST_NO_REPORTS,
} from '@streaming-infra-manager/common';

import { ingestHealthView } from './ingestHealthText';
import type { RtmpIngestSection } from './rtmpIngestText';

function rtmpPartOf(rtmp: RtmpIngestReading): RtmpIngestSection {
  const { rtmp: part } = ingestHealthView(
    {
      reading: { state: INGEST_READ, windowSeconds: 60, srt: { state: SRT_INGEST_NO_REPORTS }, rtmp },
      loadError: null,
    },
    { latencySettingOffered: false },
  );
  assert.ok(part, 'the card shows an RTMP part');
  return part;
}

const sending = (connections: number, incomingKbps: number | null, reports = 6): RtmpIngestReading => ({
  state: RTMP_INGEST_MEASURED,
  reports,
  connections,
  incomingKbps,
});

describe('the RTMP part of the ingest card', () => {
  it('says how many reports and connections SRS printed, with the ladder left out', () => {
    assert.equal(
      rtmpPartOf(sending(1, 4812)).summary,
      "From the 6 reports SRS printed in the last 60 seconds, over 1 RTMP connection. The ladder's rungs, which SRS also takes over RTMP, are not counted.",
    );
  });

  it('names one report and several connections in the right number', () => {
    assert.match(
      rtmpPartOf(sending(2, 4812, 1)).summary,
      /^From the 1 report SRS printed in the last 60 seconds, over 2 RTMP connections\./,
    );
  });

  it('gives the incoming bitrate SRS measured, and says what it is', () => {
    assert.deepEqual(rtmpPartOf(sending(1, 4812)).rows, [
      {
        label: 'Incoming bitrate',
        value: '4,812 kbps',
        detail: 'What SRS received over its last 30 seconds from each connection still sending, added up.',
      },
    ]);
  });

  it('says the bitrate is not measured yet for a connection that began moments ago, rather than zero', () => {
    assert.deepEqual(rtmpPartOf(sending(1, null)).rows, [
      {
        label: 'Incoming bitrate',
        value: 'Not measured yet',
        detail: 'SRS measures it over 30 seconds, so a connection that began moments ago has none yet.',
      },
    ]);
  });

  it('says why RTMP is not measured on an SRS that does not name the vhost, with no numbers', () => {
    const part = rtmpPartOf({ state: RTMP_INGEST_UNATTRIBUTED });

    assert.equal(
      part.summary,
      "This SRS does not name the vhost in its RTMP reports, so the manager cannot tell a broadcaster from the ladder's rungs, which SRS also takes over RTMP. RTMP ingest is not measured on this engine version.",
    );
    assert.deepEqual(part.rows, []);
  });
});
