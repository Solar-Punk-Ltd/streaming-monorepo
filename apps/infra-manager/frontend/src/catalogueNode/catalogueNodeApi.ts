import type {
  CatalogueNodeAnswer,
  CatalogueNodeClear,
  CatalogueNodeRelease,
  CatalogueNodeSave,
} from '@streaming-infra-manager/common';

import { getJson, sendJson } from '../http';

/**
 * The brand's catalogue node, over the routes of `manager/src/api/routes/catalogueNode.ts`: the designation with the
 * last reading of its batch and the last push, a designation or a move, a clear, and the release of the batch a move
 * went off. Each names the revision the page read.
 */

const CATALOGUE_NODE_PATH = '/manager-settings/catalogue-node';

export function fetchCatalogueNode(signal?: AbortSignal): Promise<CatalogueNodeAnswer> {
  return getJson<CatalogueNodeAnswer>(CATALOGUE_NODE_PATH, { cache: 'no-store', signal });
}

export function saveCatalogueNode(save: CatalogueNodeSave): Promise<CatalogueNodeAnswer> {
  return sendJson<CatalogueNodeAnswer>('PUT', CATALOGUE_NODE_PATH, save);
}

export function clearCatalogueNode(clear: CatalogueNodeClear): Promise<CatalogueNodeAnswer> {
  return sendJson<CatalogueNodeAnswer>('DELETE', CATALOGUE_NODE_PATH, clear);
}

export function releaseCatalogueNode(release: CatalogueNodeRelease): Promise<CatalogueNodeAnswer> {
  return sendJson<CatalogueNodeAnswer>('POST', `${CATALOGUE_NODE_PATH}/release`, release);
}
