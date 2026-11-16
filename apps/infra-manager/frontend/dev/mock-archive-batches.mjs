/**
 * The brand's archive batches, for the mock manager: `GET /manager-settings/archive-batches`, and `PUT` and
 * `DELETE /manager-settings/archive-batches/:batchId`, in the shapes and with the refusals of
 * `manager/src/api/routes/archiveBatches.ts`. The bodies are checked by the manager's own schemas, and a batch by the
 * shared rules, so the card refuses here what the manager refuses, with the same sentence.
 *
 * An adopt takes one of the designated catalogue node's batches, a removal reads the batch as the mock holds it and
 * takes it off only once it expired, or once its deployment is gone. The readings are the nodes' batches as the mock
 * holds them. The mock pushes nothing: the last push is the catalogue node's.
 */
import {
  ARCHIVE_ALREADY_REFUSAL,
  ARCHIVE_NO_CATALOGUE_NODE_REFUSAL,
  ARCHIVE_NOT_HELD_REFUSAL,
  ARCHIVE_UNKNOWN_REFUSAL,
  archiveBatchProblem,
  archiveIsCatalogueBatchRefusal,
  archiveRemoveProblem,
  fullestBucketFillRatio,
  stampHealthFrom,
} from '@streaming-infra-manager/common';

import {
  adoptArchiveBatchSchema,
  archiveBatchParamsSchema,
  removeArchiveBatchSchema,
} from '../../manager/src/schemas/managerSettings.ts';
import { catalogueDesignation } from './mock-catalogue-node.mjs';
import { send } from './mock-http.mjs';

const INTERVAL_MS = 30_000;
const WRITABLE_STATES = new Set(['active', 'full']);

/** The archive batches, as the manager's table holds them, and the revision an adopt and a removal name. */
export const archiveBatches = { rows: [], revision: 0 };

const normalized = (id) => id.replace(/^0x/, '').toLowerCase();
const designatedNode = () =>
  catalogueDesignation.profileName && !catalogueDesignation.clearedAt ? catalogueDesignation.profileName : null;
const catalogueBatchIds = () =>
  [catalogueDesignation.batchId, catalogueDesignation.movingFromBatchId].filter((id) => id !== null);

/** Whether a batch is an archive batch, which the catalogue designation refuses. */
export const isArchiveBatch = (batchId) => archiveBatches.rows.some((row) => row.batchId === normalized(batchId));

function readingOf(stamps, profiles, row) {
  const held = profiles().some((profile) => profile.name === row.profileName);
  const stamp = held ? stamps(row.profileName).find((entry) => normalized(entry.batchID) === row.batchId) : undefined;
  const health = held ? stampHealthFrom(row.batchId, stamp ? [stamp] : []) : stampHealthFrom(row.batchId, null);
  return {
    batchId: row.batchId,
    state: health.state,
    ttlSeconds: health.ttl,
    fillRatio: stamp ? fullestBucketFillRatio(stamp) : null,
    immutable: health.immutable,
    depth: stamp?.depth ?? row.depth,
    readAt: new Date().toISOString(),
  };
}

function answer(stamps, profiles) {
  const node = designatedNode();
  const batches = archiveBatches.rows.map((row) => {
    const reading = readingOf(stamps, profiles, row);
    return { ...row, reading, writable: node === row.profileName && WRITABLE_STATES.has(reading.state) };
  });
  const archiveIds = archiveBatches.rows.map((row) => row.batchId);
  const candidates = node
    ? stamps(node)
        .map((stamp) => ({ stamp, batchId: normalized(stamp.batchID) }))
        .filter(({ batchId }) => !archiveIds.includes(batchId))
        .map(({ stamp, batchId }) => ({
          batchId,
          nodeLabel: stamp.label ?? null,
          depth: stamp.depth,
          immutable: stamp.immutableFlag,
          ttlSeconds: stamp.batchTTL,
          problem: archiveBatchProblem(stamp, {
            batchId,
            catalogueBatchIds: catalogueBatchIds(),
            archiveBatchIds: archiveIds,
          }),
        }))
    : [];
  const now = Date.now();
  return {
    catalogueProfileName: node,
    batches,
    candidates,
    candidatesError: null,
    revision: archiveBatches.revision,
    lastPush: node ? { kind: 'store', outcome: 'stored', at: new Date(now - (now % INTERVAL_MS)).toISOString() } : null,
  };
}

async function valid(schema, value, res) {
  try {
    return await schema.validate(value, { abortEarly: false, stripUnknown: false });
  } catch (error) {
    send(res, 400, { error: 'validation_error', errors: error.errors ?? ['The request is not valid.'] });
    return null;
  }
}

function raced(res) {
  return send(res, 409, {
    error: 'manager_settings_changed',
    message: "The manager's settings changed after the page read them. Reload them and make the change again.",
  });
}

const refuse = (res, message) => send(res, 422, { error: 'archive_batch_refused', message });

/**
 * @param deps.readBody reads a JSON request body
 * @param deps.profiles every deployment the mock holds
 * @param deps.stamps the batches one deployment's node holds
 * @param deps.userFor the signed-in user of a request
 */
export function archiveBatchRoutes({ readBody, profiles, stamps, userFor }) {
  const noStore = { 'cache-control': 'no-store' };

  async function adopt(req, res, rawBatchId) {
    const params = await valid(archiveBatchParamsSchema, { batchId: rawBatchId }, res);
    if (!params) return;
    const body = await valid(adoptArchiveBatchSchema, await readBody(req), res);
    if (!body) return;
    if (body.expectedRevision !== archiveBatches.revision) return raced(res);
    const node = designatedNode();
    if (!node) return refuse(res, ARCHIVE_NO_CATALOGUE_NODE_REFUSAL);
    const batchId = normalized(params.batchId);
    if (isArchiveBatch(batchId)) return refuse(res, ARCHIVE_ALREADY_REFUSAL);
    if (catalogueBatchIds().includes(batchId)) return refuse(res, archiveIsCatalogueBatchRefusal(batchId));
    const stamp = stamps(node).find((entry) => normalized(entry.batchID) === batchId);
    if (!stamp) return refuse(res, ARCHIVE_NOT_HELD_REFUSAL);
    const problem = archiveBatchProblem(stamp, {
      batchId,
      catalogueBatchIds: catalogueBatchIds(),
      archiveBatchIds: archiveBatches.rows.map((row) => row.batchId),
    });
    if (problem) return refuse(res, problem);
    archiveBatches.rows.push({
      batchId,
      profileName: node,
      depth: stamp.depth,
      label: body.label === null ? null : body.label.trim(),
      source: 'adopted',
      purchaseRequestId: null,
      designatedAt: new Date().toISOString(),
      designatedBy: userFor(req)?.username ?? null,
    });
    archiveBatches.revision += 1;
    return send(res, 200, answer(stamps, profiles), noStore);
  }

  async function remove(req, res, rawBatchId) {
    const params = await valid(archiveBatchParamsSchema, { batchId: rawBatchId }, res);
    if (!params) return;
    const body = await valid(removeArchiveBatchSchema, await readBody(req), res);
    if (!body) return;
    if (body.expectedRevision !== archiveBatches.revision) return raced(res);
    const batchId = normalized(params.batchId);
    const row = archiveBatches.rows.find((entry) => entry.batchId === batchId);
    if (!row) return send(res, 404, { error: 'archive_batch_not_found', message: ARCHIVE_UNKNOWN_REFUSAL });
    const deploymentGone = !profiles().some((profile) => profile.name === row.profileName);
    const problem = archiveRemoveProblem(readingOf(stamps, profiles, row).state, { deploymentGone });
    if (problem) return refuse(res, problem);
    archiveBatches.rows = archiveBatches.rows.filter((entry) => entry.batchId !== batchId);
    archiveBatches.revision += 1;
    return send(res, 200, answer(stamps, profiles), noStore);
  }

  return [
    ['GET', /^\/manager-settings\/archive-batches$/, (_req, res) => send(res, 200, answer(stamps, profiles), noStore)],
    ['PUT', /^\/manager-settings\/archive-batches\/([^/]+)$/, (req, res, [batchId]) => adopt(req, res, batchId)],
    ['DELETE', /^\/manager-settings\/archive-batches\/([^/]+)$/, (req, res, [batchId]) => remove(req, res, batchId)],
  ];
}
