import {
  SRT_BAD_DROP_PERCENT,
  SRT_LINK_BAD,
  SRT_LINK_DEGRADED,
  SRT_LINK_HEALTHY,
  type SrtIngestMeasured,
  type SrtLinkVerdict,
} from '@streaming-infra-manager/common';

import { formatScaledPercent } from '../format';
import { countOf, formatCount, type IngestPill, type IngestRow } from './ingestCardText';

/**
 * The words the ingest card's SRT part says about a measured minute: a
 * sentence on what the numbers are, the counts, a verdict, and the fix when
 * the link is dropping packets.
 */

/**
 * The one step of the remedy the card can take the operator to: the SRT
 * latency in the deployment's Stack settings card.
 */
export const RAISE_LATENCY_ACTION = 'raise-srt-latency' as const;

/** What the button of that step says. */
export const RAISE_LATENCY_BUTTON = 'Change SRT latency';

export interface SrtIngestRemedyStep {
  text: string;
  action?: typeof RAISE_LATENCY_ACTION;
}

export interface SrtIngestRemedy {
  severity: 'warning' | 'error';
  title: string;
  steps: SrtIngestRemedyStep[];
}

export interface SrtIngestSection {
  summary: string;
  rows: IngestRow[];
  verdict: string;
  remedy: SrtIngestRemedy | null;
}

/** The engine setting the stack reads SRS's SRT latency from. */
export const SRT_LATENCY_SETTING_KEY = 'SRT_LATENCY';

/**
 * The SRT latency the manager writes when nobody has set one. SRS on a stack
 * that fills only `latency`, v3.1 among them, waits its own 120 on ingest
 * instead, so the card never tells the operator this is what they run with.
 */
const DEPLOYMENT_DEFAULT_LATENCY_MS = 2_000;

/**
 * Twice the manager's default. SRT runs at the larger of the two sides'
 * latencies, so a value at or under the deployment's own changes nothing.
 */
const SUGGESTED_LATENCY_MS = 2 * DEPLOYMENT_DEFAULT_LATENCY_MS;

/** OBS takes the SRT latency in microseconds. */
const OBS_SUGGESTED_LATENCY = SUGGESTED_LATENCY_MS * 1_000;

/** The pill of a measured SRT link, which leads the card while SRT is measured. */
export const SRT_VERDICT_PILL: Record<SrtLinkVerdict, IngestPill> = {
  [SRT_LINK_HEALTHY]: { label: 'Healthy', tone: 'ok' },
  [SRT_LINK_DEGRADED]: { label: 'Degraded', tone: 'warn' },
  [SRT_LINK_BAD]: { label: 'Bad', tone: 'err' },
};

export function offersLatencySetting(fields: readonly { key: string }[] | null | undefined): boolean {
  return fields?.some((field) => field.key === SRT_LATENCY_SETTING_KEY) ?? false;
}

/**
 * @param latencySettingOffered whether this deployment's engine settings have
 *   an SRT latency field, which the remedy's first step then leads to.
 */
export function srtIngestSection(
  reading: SrtIngestMeasured,
  windowSeconds: number,
  latencySettingOffered: boolean,
): SrtIngestSection {
  const { counts, percent } = reading;
  return {
    summary:
      `From the ${countOf(reading.reports, 'report')} SRS printed in the last ${windowSeconds} seconds, ` +
      `over ${countOf(reading.connections, 'SRT connection')}.`,
    rows: [
      { label: 'Packets received', value: formatCount(counts.received), detail: 'Data packets that reached SRS.' },
      {
        label: 'Lost',
        value: shareText(counts.lost, percent.lost),
        detail: 'Noticed missing on the way. SRT asks the broadcaster for these again.',
      },
      {
        label: 'Retransmitted',
        value: shareText(counts.retransmitted, percent.retransmitted),
        detail: 'Arrived on a second try.',
      },
      {
        label: 'Dropped',
        value: shareText(counts.dropped, percent.dropped),
        detail: 'Given up on and never delivered. These are the holes in the picture.',
      },
    ],
    verdict: verdictText(reading),
    remedy: reading.verdict === SRT_LINK_HEALTHY ? null : remedyFor(reading.verdict, latencySettingOffered),
  };
}

function verdictText(reading: SrtIngestMeasured): string {
  switch (reading.verdict) {
    case SRT_LINK_HEALTHY:
      return reading.counts.lost === 0
        ? 'Nothing was lost and nothing was dropped.'
        : 'Nothing was dropped. Every packet that went missing was sent again in time, so the picture is whole.';
    case SRT_LINK_DEGRADED:
      return 'Some packets arrived too late to use and were dropped, so the picture can break up in places.';
    case SRT_LINK_BAD:
      return reading.counts.received === 0
        ? 'SRS gave up on packets and received none, so the picture is breaking up.'
        : `${SRT_BAD_DROP_PERCENT}% or more of the packets were dropped, so the picture is breaking up.`;
  }
}

function remedyFor(
  verdict: typeof SRT_LINK_DEGRADED | typeof SRT_LINK_BAD,
  latencySettingOffered: boolean,
): SrtIngestRemedy {
  const raiseLatency = `Raise the SRT latency of this deployment, to ${SUGGESTED_LATENCY_MS} ms for example`;
  return {
    severity: verdict === SRT_LINK_BAD ? 'error' : 'warning',
    title: "The broadcaster's connection is losing packets, and some arrive too late to use, so the picture breaks up.",
    steps: [
      latencySettingOffered
        ? { text: `${raiseLatency}, in its stack settings.`, action: RAISE_LATENCY_ACTION }
        : {
            text:
              `${raiseLatency}. Until this manager offers that setting, the change in OBS below ` +
              "does the same from the broadcaster's side.",
          },
      {
        text:
          `Or add &latency=${OBS_SUGGESTED_LATENCY} to the end of the SRT address in OBS. OBS counts ` +
          `microseconds, so that is ${SUGGESTED_LATENCY_MS / 1_000} seconds. SRT uses the larger of the two ` +
          'sides, so this only helps when it is above the SRT latency this deployment runs with.',
      },
      { text: 'Lower the bitrate OBS broadcasts at.' },
      { text: 'Use a wired connection instead of WiFi.' },
    ],
  };
}

/** A count of packets beside its share of those received, or none at all. */
function shareText(count: number, share: number | null): string {
  if (count === 0) return 'none';
  const packets = countOf(count, 'packet');
  return share === null ? packets : `${formatScaledPercent(share)} · ${packets}`;
}
