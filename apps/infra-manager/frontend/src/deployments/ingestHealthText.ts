import {
  INGEST_NOT_RUNNING,
  INGEST_NOT_SRS,
  INGEST_READ,
  INGEST_UNREADABLE,
  type IngestHealthRead,
  type IngestHealthReading,
  type IngestNotReadState,
  RTMP_INGEST_MEASURED,
  RTMP_INGEST_NO_REPORTS,
  SRT_INGEST_MEASURED,
} from '@streaming-infra-manager/common';

import type { IngestPill } from './ingestCardText';
import { type RtmpIngestSection, rtmpIngestSection } from './rtmpIngestText';
import { SRT_VERDICT_PILL, type SrtIngestSection, srtIngestSection } from './srtIngestText';

/**
 * What the ingest card says about a reading as a whole: a pill, a sentence
 * while nothing was read or nobody is publishing, and a part for each
 * protocol SRS reported publishers on.
 *
 * The pill leads with the SRT link's verdict while SRT is measured, since
 * that is the one quality SRS reports. A broadcast over RTMP alone reads as
 * one, never as a missing SRT link, and a protocol with nothing to say has no
 * part.
 */

/** What the page holds: the last answer, or why there is none. */
export interface IngestHealthLoad {
  reading: IngestHealthReading | null;
  loadError: string | null;
}

export interface IngestHealthViewOptions {
  /** Whether this deployment's engine settings have an SRT latency field. */
  latencySettingOffered: boolean;
}

export interface IngestHealthView {
  pill: IngestPill;
  /** A sentence for the card as a whole, while nothing was read or nobody is publishing, or null. */
  summary: string | null;
  srt: SrtIngestSection | null;
  rtmp: RtmpIngestSection | null;
}

const LOG_NOT_READ_PILL: Record<IngestNotReadState, IngestPill> = {
  [INGEST_NOT_RUNNING]: { label: 'SRS not running', tone: 'gray' },
  [INGEST_UNREADABLE]: { label: 'Not read', tone: 'gray' },
  [INGEST_NOT_SRS]: { label: 'Not SRS', tone: 'gray' },
};

const NOT_READ_PILL: IngestPill = { label: 'Not read', tone: 'gray' };
const READING_PILL: IngestPill = { label: 'Reading', tone: 'info' };
const RECEIVING_RTMP_PILL: IngestPill = { label: 'Receiving over RTMP', tone: 'info' };
const RTMP_NOT_MEASURED_PILL: IngestPill = { label: 'RTMP not measured', tone: 'gray' };
const NO_PUBLISHER_PILL: IngestPill = { label: 'No publisher', tone: 'gray' };

export function ingestHealthView(load: IngestHealthLoad, options: IngestHealthViewOptions): IngestHealthView {
  const { reading, loadError } = load;
  if (!reading) {
    return nothingToShow(
      loadError ? NOT_READ_PILL : READING_PILL,
      loadError ? `Could not ask the manager. ${loadError}` : "Reading SRS's statistics.",
    );
  }
  if (reading.state !== INGEST_READ) {
    return nothingToShow(LOG_NOT_READ_PILL[reading.state], notReadSummary(reading.state));
  }
  return readView(reading, options);
}

function readView({ windowSeconds, srt, rtmp }: IngestHealthRead, options: IngestHealthViewOptions): IngestHealthView {
  const srtPart =
    srt.state === SRT_INGEST_MEASURED ? srtIngestSection(srt, windowSeconds, options.latencySettingOffered) : null;
  const rtmpPart = rtmp.state === RTMP_INGEST_NO_REPORTS ? null : rtmpIngestSection(rtmp, windowSeconds);
  if (!srtPart && !rtmpPart) return nothingToShow(NO_PUBLISHER_PILL, noPublisherSummary(windowSeconds));

  let pill = RTMP_NOT_MEASURED_PILL;
  if (srt.state === SRT_INGEST_MEASURED) pill = SRT_VERDICT_PILL[srt.verdict];
  else if (rtmp.state === RTMP_INGEST_MEASURED) pill = RECEIVING_RTMP_PILL;
  return { pill, summary: null, srt: srtPart, rtmp: rtmpPart };
}

function nothingToShow(pill: IngestPill, summary: string): IngestHealthView {
  return { pill, summary, srt: null, rtmp: null };
}

function notReadSummary(state: IngestNotReadState): string {
  switch (state) {
    case INGEST_NOT_RUNNING:
      return 'SRS is not running, so there is no ingest to read.';
    case INGEST_UNREADABLE:
      return "The manager could not read SRS's log just now. The page asks again in a few seconds.";
    case INGEST_NOT_SRS:
      return 'This deployment does not run SRS, and only SRS reports these statistics.';
  }
}

function noPublisherSummary(windowSeconds: number): string {
  return (
    `SRS reported no publisher in the last ${windowSeconds} seconds, over SRT or RTMP. ` +
    'It reports each publisher about every ten seconds while it sends, so nobody is publishing, ' +
    'or a publisher connected moments ago.'
  );
}
