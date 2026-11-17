import {
  ARCHIVE_BADGE_TEXT,
  XBZZ_DECIMALS,
  archivePauseNeedsDecision,
  type ArchiveAction,
  type ArchiveJobItem,
  type ArchiveJobSummary,
  type ArchiveQuality,
  type QualityArchiveState,
} from '@streaming-monorepo/web2-admin-common';

import { shortHex } from '../../format';
import { formatBytes, formatTook } from '../export/exportText';
import { formatShort } from '../funding/amounts';

/** What a quality's state is called on the archive panel and the stream's archive card. */
export function qualityStateText(state: QualityArchiveState): string {
  return ARCHIVE_BADGE_TEXT[state] ?? 'Not archived';
}

/** The chip colour of a quality's state. */
export const QUALITY_STATE_COLOR: Readonly<Record<QualityArchiveState, 'default' | 'success' | 'warning' | 'error'>> = {
  none: 'default',
  partial: 'warning',
  complete: 'success',
  reduced: 'success',
  unlisted: 'warning',
  outdated: 'warning',
  expired: 'error',
};

/** A count with its thousands marked: `650,000`. */
export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

/** A count of chunks with its thousands marked: `650,000 chunks`, `1 chunk`. */
export function formatChunks(chunks: number): string {
  return `${formatCount(chunks)} chunk${chunks === 1 ? '' : 's'}`;
}

/** An amount in PLUR as xBZZ, to two decimals: `0.50 xBZZ`. */
export function formatXbzz(plur: string): string {
  return `${formatShort(plur, XBZZ_DECIMALS, 2)} xBZZ`;
}

/** A range in PLUR as xBZZ: `0.50 to 0.75 xBZZ`, one figure when both ends round alike, null without both. */
export function formatXbzzRange(low: string | null, high: string | null): string | null {
  if (low === null || high === null) return null;
  const from = formatShort(low, XBZZ_DECIMALS, 2);
  const to = formatShort(high, XBZZ_DECIMALS, 2);
  return from === to ? `${to} xBZZ` : `${from} to ${to} xBZZ`;
}

/** A span of seconds in the largest two units: `45 s`, `1 min 7 s`, `1 h 4 min`. Null for none. */
export function formatSeconds(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${rest} s`;
}

/** What copying some qualities is expected to need, all together. A part is null when one of them does not know it. */
export interface ArchiveEstimate {
  chunks: number | null;
  bytes: number | null;
  bzzLowPlur: string | null;
  bzzHighPlur: string | null;
  seconds: number | null;
}

function sumNumbers(values: ReadonlyArray<number | null>): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

function sumPlur(values: ReadonlyArray<string | null>): string | null {
  let total = 0n;
  for (const value of values) {
    if (value === null || !/^\d+$/.test(value)) return null;
    total += BigInt(value);
  }
  return total.toString();
}

/** The estimates of `qualities` added up, the API's estimate of each being an upper bound. */
export function estimateOf(qualities: readonly ArchiveQuality[]): ArchiveEstimate {
  return {
    chunks: sumNumbers(qualities.map((q) => q.estimatedChunks)),
    bytes: sumNumbers(qualities.map((q) => q.estimatedBytes)),
    bzzLowPlur: sumPlur(qualities.map((q) => q.estimatedBzzLowPlur)),
    bzzHighPlur: sumPlur(qualities.map((q) => q.estimatedBzzHighPlur)),
    seconds: sumNumbers(qualities.map((q) => q.estimatedSeconds)),
  };
}

/**
 * An estimate in one line: `About 2.2 GB, 544,000 chunks, 0.42 to 0.63 xBZZ from the catalogue node's chequebook,
 * about 57 min`. What is not known is left out, and with nothing known it says so.
 */
export function estimateLine(estimate: ArchiveEstimate): string {
  const range = formatXbzzRange(estimate.bzzLowPlur, estimate.bzzHighPlur);
  const took = formatSeconds(estimate.seconds);
  const parts = [
    estimate.bytes !== null ? `about ${formatBytes(estimate.bytes)}` : null,
    estimate.chunks !== null ? formatChunks(estimate.chunks) : null,
    range ? `${range} from the catalogue node's chequebook` : null,
    took ? `about ${took}` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return 'Its size is known once it is measured';
  const line = parts.join(', ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Whether the archive pauses for a decision someone has to make, or waits for a new stamp to be confirmed. */
export function archiveNeedsDecision(job: ArchiveJobSummary): boolean {
  if (job.state === 'awaiting_purchase') return true;
  return job.state === 'paused' && archivePauseNeedsDecision(job.pauseReason);
}

/** Whether the archive moves by itself now, so its progress is shown moving. */
export function archiveMoving(job: ArchiveJobSummary): boolean {
  return (
    job.state === 'measuring' ||
    job.state === 'buying' ||
    job.state === 'waiting_usable' ||
    job.state === 'copying' ||
    job.state === 'verifying'
  );
}

function percent(part: number, whole: number | null): number | null {
  if (!whole) return null;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/** How far the copy is, 0 to 100: the chunks copied while copying, the posts synced while verifying; null otherwise. */
export function archivePercent(job: ArchiveJobSummary): number | null {
  if (job.state === 'copying') return percent(job.chunksCopied, job.chunksTotal);
  if (job.state === 'verifying') {
    const posts = job.items.reduce((sum, item) => sum + item.postsMade, 0);
    const synced = job.items.reduce((sum, item) => sum + item.chunksSynced, 0);
    return percent(synced, posts);
  }
  return null;
}

/** How far one quality is, 0 to 100, or null while it waits or is measured. */
export function archiveItemPercent(item: ArchiveJobItem): number | null {
  if (item.state === 'done') return 100;
  if (item.state === 'copying') return percent(item.chunksCopied, item.chunksTotal);
  if (item.state === 'verifying') return percent(item.chunksSynced, item.postsMade);
  return null;
}

/** The qualities the archive copies, in its order: `1080p, 720p`. */
export function archiveQualities(job: ArchiveJobSummary): string {
  return job.items.map((item) => item.label).join(', ');
}

/** Where the archive copies to: the stamp by its label or its id, or the new stamp it buys. */
export function archiveTargetText(job: ArchiveJobSummary): string {
  if (job.target.kind === 'stamp') {
    return job.target.label ? `“${job.target.label}”` : `the stamp ${shortHex(job.target.batchId)}`;
  }
  return 'a new archive stamp';
}

/** One line for the panel: where the archive stands. */
export function archiveStatusLine(job: ArchiveJobSummary): string {
  switch (job.state) {
    case 'measuring':
      return "Measuring the recording: each segment's size is read from Swarm.";
    case 'awaiting_purchase':
      return job.proposal
        ? `Measured: ${formatChunks(job.proposal.chunkCount)} to copy. A new archive stamp waits to be confirmed.`
        : 'A new archive stamp waits to be confirmed.';
    case 'buying':
      return "Buying the archive stamp: the catalogue node's transaction is not mined yet.";
    case 'waiting_usable':
      return 'The archive stamp is bought. The copy starts once the node can stamp with it, some minutes after the purchase.';
    case 'copying':
      return job.chunksTotal
        ? `Copying to Swarm: ${formatCount(job.chunksCopied)} of ${formatChunks(job.chunksTotal)}, ${formatBytes(job.bytesCopied)} so far.`
        : 'Copying to Swarm.';
    case 'verifying':
      return 'Every chunk is posted. Waiting for Bee to report each one synced to Swarm.';
    case 'paused':
      return job.pauseMessage ?? 'Paused.';
    case 'waiting':
      return 'Waiting for the stream to finish. The archive carries on by itself once it is a recording again.';
    case 'done': {
      const took = formatTook(job.startedAt, job.finishedAt);
      return `Archived on ${archiveTargetText(job)}.${took ? ` It took ${took}.` : ''}`;
    }
  }
}

/** A short line for the archive's indicator in the header. */
export function archiveWidgetLine(job: ArchiveJobSummary): string {
  switch (job.state) {
    case 'measuring':
      return 'Measuring the recording';
    case 'awaiting_purchase':
      return 'Confirm the new archive stamp';
    case 'buying':
      return 'Buying the archive stamp';
    case 'waiting_usable':
      return 'Waiting for the stamp to be usable';
    case 'copying': {
      const done = archivePercent(job);
      return done === null ? 'Copying' : `${done}% copied`;
    }
    case 'verifying': {
      const done = archivePercent(job);
      return done === null ? 'Verifying' : `Verifying: ${done}% synced`;
    }
    case 'paused':
      return archiveNeedsDecision(job) ? 'Paused: needs a decision' : 'Paused';
    case 'waiting':
      return 'Waiting for the stream to finish';
    case 'done':
      return job.items.some((item) => item.result === 'reduced') ? 'Archived, reduced protection' : 'Archived';
  }
}

/** What each action's button says, which depends on why the archive paused. */
export function archiveActionLabel(action: ArchiveAction, job: ArchiveJobSummary): string {
  switch (action) {
    case 'pause':
      return 'Pause';
    case 'resume':
      if (job.pauseReason === 'batch') return 'Try again after a dilution';
      if (job.pauseReason === 'funds') return 'Try again after funding it';
      if (job.pauseReason === 'user' || job.pauseReason === null) return 'Resume';
      return 'Try again';
    case 'wait':
      return 'Wait until it finishes';
    case 'use_stamp':
      return 'Use another stamp';
    case 'buy_new':
      return 'Buy a new archive stamp';
    case 'cancel':
      return 'Cancel archive';
    case 'dismiss':
      return 'Close';
  }
}

/** Where one quality of the archive stands. */
export function archiveItemLine(item: ArchiveJobItem): string {
  switch (item.state) {
    case 'waiting':
      return 'Waits its turn';
    case 'measuring':
      return 'Measuring';
    case 'copying': {
      const rebuilt = item.chunksRebuilt > 0 ? `, ${formatCount(item.chunksRebuilt)} rebuilt from parity` : '';
      return item.chunksTotal
        ? `${formatCount(item.chunksCopied)} of ${formatChunks(item.chunksTotal)} copied${rebuilt}`
        : `Copying${rebuilt}`;
    }
    case 'verifying':
      return `${formatCount(item.chunksSynced)} of ${formatCount(item.postsMade)} posts synced`;
    case 'done':
      return item.result === 'reduced'
        ? `Archived, reduced protection: ${formatCount(item.parityMissing)} parity chunk${item.parityMissing === 1 ? '' : 's'} could not be read`
        : 'Archived';
  }
}
