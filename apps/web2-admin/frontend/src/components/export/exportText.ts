import { pauseNeedsDecision, type ExportAction, type ExportSummary } from '@streaming-monorepo/web2-admin-common';

/** Sizes as the API's sentences give them: decimal, so 6.6 GB is 6,600,000,000 bytes. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'unknown size';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} kB`;
}

/** A recording's length as a player shows it: `1:04:14`, or `32:41` under an hour. */
export function formatLength(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'length unknown';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** How far the reading is, 0 to 100, or null before the playlist was read and while joining. */
export function percentRead(current: ExportSummary): number | null {
  if (current.state === 'joining' || !current.segmentsTotal) return null;
  return Math.min(100, Math.round((current.segmentsRead / current.segmentsTotal) * 100));
}

/** Whether the export pauses for a decision someone has to make. */
export function needsDecision(current: ExportSummary): boolean {
  return current.state === 'paused' && pauseNeedsDecision(current.pauseReason);
}

/** One line for the panel: where the export stands. */
export function statusLine(current: ExportSummary): string {
  switch (current.state) {
    case 'reading':
      return current.segmentsTotal
        ? `Reading segments from Swarm: ${current.segmentsRead} of ${current.segmentsTotal}, ${formatBytes(current.bytesRead)} so far.`
        : 'Reading the recording playlist from Swarm.';
    case 'joining':
      return 'Joining the segments into an MP4.';
    case 'paused':
      return current.pauseMessage ?? 'Paused.';
    case 'waiting':
      return 'Waiting for the stream to finish. The export carries on by itself once it is a recording again.';
    case 'done':
      return `Ready: ${current.fileName ?? 'the file'}, ${formatBytes(current.sizeBytes)}.`;
  }
}

/** A short line for the widget. */
export function widgetLine(current: ExportSummary): string {
  switch (current.state) {
    case 'reading': {
      const percent = percentRead(current);
      return percent === null ? 'Reading the playlist' : `${percent}% read`;
    }
    case 'joining':
      return 'Joining into an MP4';
    case 'paused':
      return needsDecision(current) ? 'Paused: needs a decision' : 'Paused';
    case 'waiting':
      return 'Waiting for the stream to finish';
    case 'done':
      return `Ready to save, ${formatBytes(current.sizeBytes)}`;
  }
}

/** What each action's button says, which depends on why the export paused. */
export function actionLabel(action: ExportAction, current: ExportSummary): string {
  switch (action) {
    case 'pause':
      return 'Pause';
    case 'resume':
      if (current.pauseReason === 'unreadable') return 'Try them again';
      if (current.pauseReason === 'problem') return 'Try again';
      return 'Resume';
    case 'save':
      return current.pauseReason === 'unreadable' ? 'Save without them' : "Save what's read";
    case 'wait':
      return 'Wait until it finishes';
    case 'cancel':
      return 'Cancel export';
    case 'dismiss':
      return 'Close';
  }
}
