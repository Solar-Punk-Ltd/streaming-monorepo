import type { Tone } from '../components/tone';

/** The shapes and number formats the ingest card's SRT and RTMP parts share. */

export interface IngestPill {
  label: string;
  tone: Tone;
}

export interface IngestRow {
  label: string;
  value: string;
  /** What the number means, in words. */
  detail: string;
}

/** A count with its noun, in the right number: "1 report", "6 reports". */
export function countOf(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}
