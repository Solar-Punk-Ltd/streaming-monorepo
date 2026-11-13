import type { ArchiveBatchAdopt, ArchiveBatchesAnswer, ArchiveBatchRemove } from '@streaming-infra-manager/common';

import { getJson, sendJson } from '../http';

/**
 * The brand's archive batches, over the routes of `manager/src/api/routes/archiveBatches.ts`: the list with each
 * batch's last reading and the catalogue node's other batches, an adopt and a removal. Each names the revision the
 * page read.
 */

const ARCHIVE_BATCHES_PATH = '/manager-settings/archive-batches';

export function fetchArchiveBatches(signal?: AbortSignal): Promise<ArchiveBatchesAnswer> {
  return getJson<ArchiveBatchesAnswer>(ARCHIVE_BATCHES_PATH, { cache: 'no-store', signal });
}

export function adoptArchiveBatch(batchId: string, adopt: ArchiveBatchAdopt): Promise<ArchiveBatchesAnswer> {
  return sendJson<ArchiveBatchesAnswer>('PUT', `${ARCHIVE_BATCHES_PATH}/${encodeURIComponent(batchId)}`, adopt);
}

export function removeArchiveBatch(batchId: string, remove: ArchiveBatchRemove): Promise<ArchiveBatchesAnswer> {
  return sendJson<ArchiveBatchesAnswer>('DELETE', `${ARCHIVE_BATCHES_PATH}/${encodeURIComponent(batchId)}`, remove);
}
