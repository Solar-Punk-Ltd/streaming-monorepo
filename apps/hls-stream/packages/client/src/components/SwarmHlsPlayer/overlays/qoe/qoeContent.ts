import { type PlayerRelease, playerReleaseText } from '@/utils/playerRelease';

import { LIVE_SYNC_DURATION_S } from '../../playerConfig';

import type { QoeMetrics } from './useHlsQoeMetrics';

/** One label and value of the panel, as it prints them. `bad` is how the panel colours the value, and nothing more. */
export interface QoeRow {
  label: string;
  value: string;
  bad?: boolean;
}

interface QoeSection {
  title: string;
  rows: QoeRow[];
}

/**
 * The panel top to bottom, every string as the panel prints it. The panel renders this and the export writes it, so
 * the two cannot drift apart.
 */
export interface QoeContent {
  title: string;
  /** The release line, or null when the panel shows none. */
  player: string | null;
  sections: QoeSection[];
  footer: string;
}

const QOE_TITLE = 'QoE Metrics';

const fmtMs = (ms: number | null) => (ms == null ? '—' : `${Math.round(ms)} ms`);
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** The panel's content from the metrics and the release the player was built as. */
export function qoeContent(m: QoeMetrics, release: PlayerRelease | null): QoeContent {
  // Read defensively rather than trusted. The metrics object is built once inside a long-lived
  // closure in attachQoeTracking, so during a hot reload this panel can render against a snapshot
  // taken before a field existed. An observability panel must not be able to take the player down
  // with it, which is exactly what an unguarded .map() here did.
  const ladder = m.ladder ?? [];

  return {
    title: QOE_TITLE,
    player: release ? playerReleaseText(release) : null,
    sections: [
      {
        title: 'Startup',
        rows: [
          { label: 'Startup Time', value: fmtMs(m.startupTimeMs) },
          { label: 'First Frame Time', value: fmtMs(m.firstFrameTimeMs) },
          { label: 'Startup Failure', value: m.startupFailed ? 'YES' : 'no', bad: m.startupFailed },
        ],
      },
      {
        title: 'Rebuffering',
        rows: [
          { label: 'Count', value: String(m.rebufferingCount), bad: m.rebufferingCount > 0 },
          { label: 'Duration', value: fmtMs(m.rebufferingDurationMs) },
          { label: 'Ratio', value: fmtPct(m.rebufferingRatio), bad: m.rebufferingRatio > 0.01 },
          { label: 'Any Rebuffering', value: m.hadRebuffering ? 'yes' : 'no', bad: m.hadRebuffering },
        ],
      },
      {
        title: 'Quality',
        rows: [
          { label: 'Delivered Bitrate', value: m.bitrateKbps != null ? `${m.bitrateKbps} kbps` : '—' },
          { label: 'Delivered Resolution', value: m.resolution ?? '—' },
          { label: 'Quality Switches', value: String(m.qualitySwitchCount) },
          { label: 'Switch Frequency', value: `${m.qualitySwitchPerMin.toFixed(2)}/min` },
          { label: 'Dropped Frames', value: String(m.droppedFrames), bad: m.droppedFrames > 0 },
        ],
      },
      {
        title: 'Live',
        rows: [
          {
            label: 'E2E Live Latency',
            value: m.liveLatencySec != null ? `${m.liveLatencySec.toFixed(2)} s` : '—',
          },
          {
            label: 'Latency Target',
            value: m.liveTargetLatencySec != null ? `${m.liveTargetLatencySec.toFixed(2)} s` : '—',
            bad: m.liveTargetLatencySec != null && m.liveTargetLatencySec > LIVE_SYNC_DURATION_S,
          },
          { label: 'Buffer Stalls', value: String(m.bufferStallCount), bad: m.bufferStallCount > 0 },
        ],
      },
      {
        title: 'ABR',
        rows: [
          { label: 'Level Selection', value: m.abrEnabled ? 'auto' : 'pinned' },
          { label: 'Selected Rung', value: m.selectedHeight != null ? `${m.selectedHeight}p` : '—' },
          {
            label: 'Bandwidth Estimate',
            value: m.bandwidthEstimateKbps != null ? `${m.bandwidthEstimateKbps} kbps` : '—',
          },
          { label: 'Switch Latency', value: fmtMs(m.lastSwitchLatencyMs) },
          { label: 'Switch Latency (avg)', value: fmtMs(m.avgSwitchLatencyMs) },
          {
            label: 'Switch Latency (max)',
            value: fmtMs(m.maxSwitchLatencyMs),
            bad: (m.maxSwitchLatencyMs ?? 0) > 5000,
          },
          { label: 'Switches Measured', value: String(m.switchLatencySamples) },
          ...ladder.map((level) => ({
            label: `${level.current ? '▸' : ' '} ${level.height}p`,
            value: `${level.bitrateKbps} kbps${level.capped ? ' · capped' : ''}${
              level.unaffordable ? ' · unaffordable' : ''
            }`,
            bad: level.capped || level.unaffordable,
          })),
          ...(ladder.length > 0
            ? [{ label: 'ABR would pick', value: m.nextHeight != null ? `${m.nextHeight}p` : '—' }]
            : []),
        ],
      },
      {
        title: 'Reliability',
        rows: [
          { label: 'Fatal Errors', value: String(m.fatalErrorCount), bad: m.fatalErrorCount > 0 },
          { label: 'Fatal Error Rate', value: m.fatalErrorCount > 0 ? 'yes' : 'none', bad: m.fatalErrorCount > 0 },
          { label: 'Session Complete', value: m.sessionCompleted ? 'yes' : 'in progress' },
          { label: 'Startup Failure Rate', value: m.startupFailed ? 'failed' : 'ok', bad: m.startupFailed },
          { label: 'Reconnect Attempts', value: String(m.reconnectAttempts) },
          {
            label: 'Reconnect Success Rate',
            value: m.reconnectAttempts > 0 ? fmtPct(m.reconnectSuccessRate) : '—',
          },
          { label: 'Recovery Time', value: fmtMs(m.lastRecoveryTimeMs) },
        ],
      },
    ],
    footer: `Playback: ${fmtMs(m.playbackTimeMs)}`,
  };
}
