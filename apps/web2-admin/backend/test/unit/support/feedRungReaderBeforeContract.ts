/**
 * The reader the admin used for a rung read back off the catalog before the contracts package held it, copied as it
 * was so feedRungReaderParity.test.ts can show the contract reads every rung the same way.
 */
import type { Rendition } from '@streaming-monorepo/web2-admin-common';

export function isRendition(value: unknown): value is Rendition {
  if (typeof value !== 'object' || value === null) return false;
  const rung = value as Record<string, unknown>;
  return (
    typeof rung.name === 'string' &&
    typeof rung.width === 'number' &&
    typeof rung.height === 'number' &&
    typeof rung.topic === 'string' &&
    typeof rung.bandwidth === 'number' &&
    typeof rung.avgBandwidth === 'number' &&
    (rung.recording === undefined || typeof rung.recording === 'string') &&
    (rung.duration === undefined || typeof rung.duration === 'number')
  );
}
