import {
  RTMP_INGEST_MEASURED,
  RTMP_INGEST_NO_REPORTS,
  RTMP_INGEST_UNATTRIBUTED,
  type RtmpIngestMeasured,
  type RtmpIngestReading,
} from '@streaming-infra-manager/common';

import type { RtmpPublishReport } from './rtmpPublishReport.js';

/**
 * The vhost broadcasters publish onto: SRS's default vhost, which is the one
 * the stack's SRS template takes ingest on. The ladder's rungs are republished
 * onto a vhost of their own.
 */
export const INGEST_VHOST = '__defaultVhost__';

/** Where one connection's reports sit in the window, by their order in the log. */
interface ConnectionSpan {
  first: number;
  last: number;
  latestKbps: number;
}

/**
 * One RTMP reading from every RTMP publisher report in the window.
 *
 * Only the ingest vhost's reports count. The ladder's rungs are RTMP
 * publishers too, republished from SRS's own host, and counting them would
 * show a broadcast that is not there. An SRS that names no vhost cannot tell
 * the two apart, and saying so is the honest answer. Once any report names
 * its vhost, the engine is one that does, and an older line left in the
 * window from before an upgrade says nothing more.
 */
export function rtmpIngestReadingFrom(reports: readonly RtmpPublishReport[]): RtmpIngestReading {
  const ingest = reports.filter((report) => report.vhost === INGEST_VHOST);
  if (ingest.length > 0) return measuredFrom(ingest);
  const namesVhosts = reports.some((report) => report.vhost !== null);
  if (reports.length > 0 && !namesVhosts) return { state: RTMP_INGEST_UNATTRIBUTED };
  return { state: RTMP_INGEST_NO_REPORTS };
}

function measuredFrom(reports: readonly RtmpPublishReport[]): RtmpIngestMeasured {
  const spans = new Map<string, ConnectionSpan>();
  reports.forEach((report, index) => {
    const span = spans.get(report.connection);
    spans.set(report.connection, {
      first: span?.first ?? index,
      last: index,
      latestKbps: report.incomingKbps,
    });
  });
  const sending = stillSending([...spans.values()]);
  // A 30-second average of zero is one SRS has not taken yet: SRS drops a publisher that sends nothing for seconds.
  const measured = sending.map((span) => span.latestKbps).filter((kbps) => kbps > 0);
  return {
    state: RTMP_INGEST_MEASURED,
    reports: reports.length,
    connections: spans.size,
    incomingKbps: measured.length > 0 ? measured.reduce((sum, kbps) => sum + kbps, 0) : null,
  };
}

/**
 * The connections that were still sending at the end of the window.
 *
 * A connection whose last report comes before another connection's first had
 * ended by then: a publisher that reconnected, or one broadcaster after
 * another. Connections that send at once report in turn, so each one's last
 * report comes after the other's first.
 */
function stillSending(spans: readonly ConnectionSpan[]): ConnectionSpan[] {
  const latestStart = Math.max(...spans.map((span) => span.first));
  return spans.filter((span) => span.last >= latestStart);
}
