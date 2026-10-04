import type { SrtLinkCounts } from '@streaming-infra-manager/common';

import { DIGITS, HOST_DIGITS, SRS_LINE_PREFIX, srsLogText, wholeHostLine } from './srsLogLine.js';

/**
 * SRS's per-publisher SRT statistics line, and nothing else from its log.
 *
 * SRS prints one for each SRT publisher about every ten seconds. It clears
 * libsrt's counters as it reads them, so each line counts its own interval:
 *
 *   [2026-09-22 17:33:50.386][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6500, pktRcvLoss=394, pktRcvRetrans=381, pktRcvDrop=397
 *
 * The bracket before the message is SRS's id for the connection. The same log
 * carries the webhook URL with the uploader's token in it and the publisher's
 * address, so a line is either exactly this shape, anchored at both ends, or it
 * is not read at all, and what comes out is four counts and the connection id.
 */

/** One statistics line: one SRT connection's counts over one interval. */
export interface TransportStatsReport {
  /** SRS's id for the connection, used only to tell connections apart. It never leaves the manager. */
  connection: string;
  counts: SrtLinkCounts;
}

const COUNT = `(${DIGITS})`;

const REPORT_LINE = new RegExp(
  `^${SRS_LINE_PREFIX}<- SRT_CPB Transport Stats # ` +
    `pktRecv=${COUNT}, pktRcvLoss=${COUNT}, pktRcvRetrans=${COUNT}, pktRcvDrop=${COUNT}$`,
);

/** The same report shape as a POSIX extended regular expression, for a reader that filters with grep on another host. */
export const TRANSPORT_STATS_HOST_PATTERN = wholeHostLine(
  '<- SRT_CPB Transport Stats # ' +
    `pktRecv=${HOST_DIGITS}, pktRcvLoss=${HOST_DIGITS}, pktRcvRetrans=${HOST_DIGITS}, pktRcvDrop=${HOST_DIGITS}`,
);

export function parseTransportStatsLine(line: string): TransportStatsReport | null {
  const match = REPORT_LINE.exec(srsLogText(line));
  if (!match) return null;
  const [, connection, received, lost, retransmitted, dropped] = match;
  return {
    connection,
    counts: {
      received: Number(received),
      lost: Number(lost),
      retransmitted: Number(retransmitted),
      dropped: Number(dropped),
    },
  };
}

/** Every statistics line among `lines`, in order. Any other line is skipped without a trace. */
export function parseTransportStatsLines(lines: readonly string[]): TransportStatsReport[] {
  return lines.flatMap((line) => {
    const report = parseTransportStatsLine(line);
    return report ? [report] : [];
  });
}
