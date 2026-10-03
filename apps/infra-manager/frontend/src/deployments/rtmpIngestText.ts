import {
  RTMP_INGEST_MEASURED,
  type RtmpIngestMeasured,
  type RtmpIngestUnattributed,
} from '@streaming-infra-manager/common';

import { countOf, formatCount, type IngestRow } from './ingestCardText';

/**
 * The words the ingest card's RTMP part says: how many publishers SRS
 * reported on the ingest vhost and the bitrate it received from them, or why
 * RTMP is not measured on this engine.
 */

export interface RtmpIngestSection {
  summary: string;
  rows: IngestRow[];
}

const RUNGS_LEFT_OUT = "The ladder's rungs, which SRS also takes over RTMP, are not counted.";

export function rtmpIngestSection(
  reading: RtmpIngestMeasured | RtmpIngestUnattributed,
  windowSeconds: number,
): RtmpIngestSection {
  if (reading.state !== RTMP_INGEST_MEASURED) {
    return {
      summary:
        "This SRS does not name the vhost in its RTMP reports, so the manager cannot tell a broadcaster from the ladder's " +
        'rungs, which SRS also takes over RTMP. RTMP ingest is not measured on this engine version.',
      rows: [],
    };
  }
  return {
    summary:
      `From the ${countOf(reading.reports, 'report')} SRS printed in the last ${windowSeconds} seconds, ` +
      `over ${countOf(reading.connections, 'RTMP connection')}. ${RUNGS_LEFT_OUT}`,
    rows: [incomingRow(reading.incomingKbps)],
  };
}

function incomingRow(incomingKbps: number | null): IngestRow {
  if (incomingKbps === null) {
    return {
      label: 'Incoming bitrate',
      value: 'Not measured yet',
      detail: 'SRS measures it over 30 seconds, so a connection that began moments ago has none yet.',
    };
  }
  return {
    label: 'Incoming bitrate',
    value: `${formatCount(incomingKbps)} kbps`,
    detail: 'What SRS received over its last 30 seconds from each connection still sending, added up.',
  };
}
