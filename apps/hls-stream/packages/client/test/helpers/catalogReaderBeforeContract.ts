/**
 * The viewer's readers of a catalog entry and of a rung before the contracts package held them, copied as they were
 * so catalogReaderParity.test.ts can show the contract reads every entry the same way.
 */
import { mediaTypeSchema } from '@swarm-hls-stream/shared';

import { Rendition, Stream } from '@/types/stream';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

export function isRendition(value: unknown): value is Rendition {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === 'string' &&
    typeof value.topic === 'string' &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    isFiniteNumber(value.bandwidth) &&
    isFiniteNumber(value.avgBandwidth) &&
    isOptionalFiniteNumber(value.index) &&
    isOptionalFiniteNumber(value.duration)
  );
}

export function isStream(value: unknown): value is Stream {
  if (!isRecord(value)) {
    return false;
  }

  const hasUsableRenditions =
    value.renditions === undefined || (Array.isArray(value.renditions) && value.renditions.every(isRendition));
  const hasUsableDuration =
    value.duration === undefined || typeof value.duration === 'string' || isFiniteNumber(value.duration);
  const hasUsableScheduledStart =
    value.scheduledStartTime === undefined ||
    value.scheduledStartTime === null ||
    typeof value.scheduledStartTime === 'string' ||
    isFiniteNumber(value.scheduledStartTime);

  return (
    typeof value.owner === 'string' &&
    typeof value.topic === 'string' &&
    typeof value.title === 'string' &&
    isFiniteNumber(value.timestamp) &&
    mediaTypeSchema.safeParse(value.mediatype).success &&
    (value.state === undefined || typeof value.state === 'string') &&
    hasUsableDuration &&
    isOptionalFiniteNumber(value.index) &&
    (value.thumbnail === undefined || typeof value.thumbnail === 'string') &&
    hasUsableScheduledStart &&
    hasUsableRenditions
  );
}
