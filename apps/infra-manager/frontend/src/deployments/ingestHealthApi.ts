import type { IngestHealthReading } from '@streaming-infra-manager/common';

import { getJson } from '../http';

/** What SRS's own statistics say about this deployment's ingest over the last minute. */
export function fetchIngestHealth(name: string, signal?: AbortSignal): Promise<IngestHealthReading> {
  return getJson<IngestHealthReading>(`/profiles/${encodeURIComponent(name)}/ingest-health`, { signal });
}
