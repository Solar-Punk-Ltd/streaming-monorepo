import { DIGITS, HOST_DIGITS, SRS_LINE_PREFIX, srsLogText, wholeHostLine } from './srsLogLine.js';

/**
 * SRS's periodic line for each RTMP publisher, and nothing else from its log.
 *
 * SRS prints one for each RTMP publisher about every ten seconds:
 *
 *   [2026-10-03 17:43:50.386][INFO][1][9tq3vz71] <- CPB time=40021, okbps=0,0,0, ikbps=0,4812,0, mr=0/350, p1stpt=20000, pnt=5000, vhost=__defaultVhost__
 *
 * Images of the stack's SRS fork from 6.0-r2-swarm.3 end it with the vhost
 * the publisher is on, and older images end it at `pnt`. The three `ikbps`
 * numbers are the kilobits a second SRS received: since the connection began,
 * over its last 30-second sample and over its last 5-minute one. SRS never
 * sets the start the first is measured from, so it reads as zero, and the
 * second stays zero until SRS has sampled 30 seconds of the connection.
 *
 * The same log carries the stream key, the webhook URL with the uploader's
 * token in it and the publisher's address on other lines, so a line is either
 * exactly this shape, anchored at both ends, or it is not read at all, and
 * what comes out is the connection id, the vhost and the 30-second bitrate.
 */

/** One RTMP publisher report: one connection's incoming bitrate, and the vhost it is on when SRS names it. */
export interface RtmpPublishReport {
  /** SRS's id for the connection, used only to tell connections apart. It never leaves the manager. */
  connection: string;
  /** The configured vhost the publisher is on, or null from an SRS that does not name it. */
  vhost: string | null;
  /** Kilobits a second over SRS's last 30-second sample of the connection, zero before its first. */
  incomingKbps: number;
}

/** A vhost name as the stack's SRS entrypoint takes one. */
const VHOST_NAME = '[A-Za-z0-9._-]{1,253}';

const REPORT_LINE = new RegExp(
  `^${SRS_LINE_PREFIX}<- CPB time=${DIGITS}, okbps=${DIGITS},${DIGITS},${DIGITS}, ` +
    `ikbps=${DIGITS},(${DIGITS}),${DIGITS}, mr=${DIGITS}/${DIGITS}, p1stpt=${DIGITS}, pnt=${DIGITS}` +
    `(?:, vhost=(${VHOST_NAME}))?$`,
);

/** The same report shape as a POSIX extended regular expression, for a reader that filters with grep on another host. */
export const RTMP_PUBLISH_HOST_PATTERN = wholeHostLine(
  `<- CPB time=${HOST_DIGITS}, okbps=${HOST_DIGITS},${HOST_DIGITS},${HOST_DIGITS}, ` +
    `ikbps=${HOST_DIGITS},${HOST_DIGITS},${HOST_DIGITS}, mr=${HOST_DIGITS}/${HOST_DIGITS}, ` +
    `p1stpt=${HOST_DIGITS}, pnt=${HOST_DIGITS}(, vhost=${VHOST_NAME})?`,
);

export function parseRtmpPublishReport(line: string): RtmpPublishReport | null {
  const match = REPORT_LINE.exec(srsLogText(line));
  if (!match) return null;
  const [, connection, incomingKbps, vhost] = match;
  return { connection, vhost: vhost ?? null, incomingKbps: Number(incomingKbps) };
}

/** Every RTMP publisher report among `lines`, in order. Any other line is skipped without a trace. */
export function parseRtmpPublishReports(lines: readonly string[]): RtmpPublishReport[] {
  return lines.flatMap((line) => {
    const report = parseRtmpPublishReport(line);
    return report ? [report] : [];
  });
}
