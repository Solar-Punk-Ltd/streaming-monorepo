/**
 * The brand's catalogue node, for the mock manager: `GET`, `PUT` and `DELETE /manager-settings/catalogue-node`, and
 * `POST /manager-settings/catalogue-node/release`, in the shapes and with the refusals of
 * `manager/src/api/routes/catalogueNode.ts`. The bodies are checked by the manager's own schemas, and a deployment and
 * a batch by the shared rules, so the card refuses here what the manager refuses, with the same sentence.
 *
 * Once a batch has been designated it stays recorded through a clear, as the manager keeps it: that batch can be
 * designated again, another one only with `move: true`, which records the pinned one as the batch moved from, and
 * while a move is pending a third batch is refused until a release. The deployments of both batches are not removed.
 *
 * The mock pushes nothing. A designation reads as sent at the last 30-second mark, the cadence the manager pushes
 * on, and a clear as cleared when it was made. The readings are the nodes' batches as the mock holds them.
 */
import {
  catalogueBatchProblem,
  catalogueMoveRefusal,
  catalogueNodeProblem,
  catalogueReleaseFirstRefusal,
  CATALOGUE_NO_MOVE_REFUSAL,
  CATALOGUE_NOT_HELD_REFUSAL,
  fullestBucketFillRatio,
  stampHealthFrom,
} from '@streaming-infra-manager/common';

import {
  clearCatalogueNodeSchema,
  releaseCatalogueNodeSchema,
  saveCatalogueNodeSchema,
} from '../../manager/src/schemas/managerSettings.ts';
import { send } from './mock-http.mjs';

const INTERVAL_MS = 30_000;

/** The designation, as the manager's single-row table holds it. `clearedAt` set is a designation taken out. */
export const catalogueDesignation = {
  profileName: null,
  batchId: null,
  designatedAt: null,
  designatedBy: null,
  clearedAt: null,
  movingFromProfileName: null,
  movingFromBatchId: null,
  moveStartedAt: null,
  moveStartedBy: null,
  releasedAt: null,
  releasedBy: null,
  revision: 0,
};

const designated = () => Boolean(catalogueDesignation.profileName) && !catalogueDesignation.clearedAt;
const normalized = (id) => id.replace(/^0x/, '').toLowerCase();

function readingOf(stamps, profileName, batchId) {
  const stamp = stamps(profileName).find((entry) => normalized(entry.batchID) === batchId);
  const health = stampHealthFrom(batchId, stamp ? [stamp] : []);
  return {
    batchId,
    state: health.state,
    ttlSeconds: health.ttl,
    fillRatio: stamp ? fullestBucketFillRatio(stamp) : null,
    immutable: health.immutable,
    depth: stamp?.depth ?? null,
    readAt: new Date().toISOString(),
  };
}

function lastPushOf(now = Date.now()) {
  if (designated()) {
    return { kind: 'store', outcome: 'stored', at: new Date(now - (now % INTERVAL_MS)).toISOString() };
  }
  if (catalogueDesignation.clearedAt) {
    return { kind: 'clear', outcome: 'cleared', at: catalogueDesignation.clearedAt };
  }
  return null;
}

function answer(stamps) {
  const d = catalogueDesignation;
  const { profileName, batchId, designatedAt, designatedBy, revision } = d;
  return {
    designation: designated() ? { profileName, batchId, designatedAt, designatedBy } : null,
    pinned: profileName ? { profileName, batchId } : null,
    movingFrom: d.movingFromBatchId
      ? {
          profileName: d.movingFromProfileName,
          batchId: d.movingFromBatchId,
          startedAt: d.moveStartedAt,
          startedBy: d.moveStartedBy,
          reading: readingOf(stamps, d.movingFromProfileName, d.movingFromBatchId),
        }
      : null,
    lastRelease: d.releasedAt ? { at: d.releasedAt, by: d.releasedBy } : null,
    revision,
    reading: designated() ? readingOf(stamps, profileName, batchId) : null,
    lastPush: lastPushOf(),
  };
}

async function validBody(schema, req, readBody, res) {
  try {
    return await schema.validate(await readBody(req), { abortEarly: false, stripUnknown: false });
  } catch (error) {
    send(res, 400, { error: 'validation_error', errors: error.errors ?? ['The request body is not valid.'] });
    return null;
  }
}

function raced(res) {
  return send(res, 409, {
    error: 'manager_settings_changed',
    message: "The manager's settings changed after the page read them. Reload them and make the change again.",
  });
}

const refuse = (res, reason) => send(res, 400, { error: 'validation_error', errors: [reason] });

/**
 * @param deps.readBody reads a JSON request body
 * @param deps.profiles every deployment the mock holds
 * @param deps.groups every group the mock holds
 * @param deps.stamps the batches one deployment's node holds
 * @param deps.userFor the signed-in user of a request
 */
export function catalogueNodeRoutes({ readBody, profiles, groups, stamps, userFor }) {
  const noStore = { 'cache-control': 'no-store' };

  async function designate(req, res) {
    const body = await validBody(saveCatalogueNodeSchema, req, readBody, res);
    if (!body) return;
    if (body.expectedRevision !== catalogueDesignation.revision) return raced(res);
    const batchId = normalized(body.batchId);
    const pinned = catalogueDesignation.batchId;
    const movingFrom = catalogueDesignation.movingFromBatchId;
    const moving = pinned !== null && pinned !== batchId;
    if (moving && movingFrom && movingFrom !== batchId) return refuse(res, catalogueReleaseFirstRefusal(movingFrom));
    if (moving && body.move !== true) return refuse(res, catalogueMoveRefusal(pinned, batchId));
    const profile = profiles().find((entry) => entry.name === body.profileName);
    if (!profile) return refuse(res, `There is no deployment called ${body.profileName}.`);
    const groupKind = groups().find((group) => group.id === profile.group_id)?.kind ?? null;
    const nodeProblem = catalogueNodeProblem(profile, groupKind);
    if (nodeProblem) return refuse(res, nodeProblem);
    const stamp = stamps(profile.name).find((entry) => normalized(entry.batchID) === batchId);
    if (!stamp) return refuse(res, CATALOGUE_NOT_HELD_REFUSAL);
    const batchProblem = catalogueBatchProblem(stamp);
    if (batchProblem) return refuse(res, batchProblem);
    const at = new Date().toISOString();
    const username = userFor(req)?.username ?? null;
    if (moving) {
      Object.assign(catalogueDesignation, {
        movingFromProfileName: catalogueDesignation.profileName,
        movingFromBatchId: pinned,
        moveStartedAt: at,
        moveStartedBy: username,
      });
    }
    Object.assign(catalogueDesignation, {
      profileName: profile.name,
      batchId,
      designatedAt: at,
      designatedBy: username,
      clearedAt: null,
      revision: catalogueDesignation.revision + 1,
    });
    return send(res, 200, answer(stamps), noStore);
  }

  async function clear(req, res) {
    const body = await validBody(clearCatalogueNodeSchema, req, readBody, res);
    if (!body) return;
    if (body.expectedRevision !== catalogueDesignation.revision) return raced(res);
    if (!designated()) return refuse(res, 'No catalogue node is designated.');
    Object.assign(catalogueDesignation, {
      designatedBy: userFor(req)?.username ?? null,
      clearedAt: new Date().toISOString(),
      revision: catalogueDesignation.revision + 1,
    });
    return send(res, 200, answer(stamps), noStore);
  }

  async function release(req, res) {
    const body = await validBody(releaseCatalogueNodeSchema, req, readBody, res);
    if (!body) return;
    if (body.expectedRevision !== catalogueDesignation.revision) return raced(res);
    if (!catalogueDesignation.movingFromBatchId) return refuse(res, CATALOGUE_NO_MOVE_REFUSAL);
    Object.assign(catalogueDesignation, {
      movingFromProfileName: null,
      movingFromBatchId: null,
      moveStartedAt: null,
      moveStartedBy: null,
      releasedAt: new Date().toISOString(),
      releasedBy: userFor(req)?.username ?? null,
      revision: catalogueDesignation.revision + 1,
    });
    return send(res, 200, answer(stamps), noStore);
  }

  return [
    ['GET', /^\/manager-settings\/catalogue-node$/, (_req, res) => send(res, 200, answer(stamps), noStore)],
    ['PUT', /^\/manager-settings\/catalogue-node$/, (req, res) => designate(req, res)],
    ['DELETE', /^\/manager-settings\/catalogue-node$/, (req, res) => clear(req, res)],
    ['POST', /^\/manager-settings\/catalogue-node\/release$/, (req, res) => release(req, res)],
  ];
}

/**
 * The refusal of removing the catalogue node, designated or cleared, or the node of the batch a pending move went
 * off, as the manager's removal guard answers it.
 */
export function catalogueRemovalRefusal(name) {
  if (catalogueDesignation.profileName === name) {
    return {
      error: 'catalogue_node_designated',
      message: `${name} is the brand's catalogue node: its batch stamps the catalogue's history. Move the catalogue to another node and release this batch on the Manager settings page before removing it.`,
    };
  }
  if (catalogueDesignation.movingFromProfileName === name) {
    return {
      error: 'catalogue_node_designated',
      message: `${name} holds the batch the brand's catalogue is moving from, which keeps the catalogue's history until the web2 admin reports the move done. Release the previous batch on the Manager settings page before removing it.`,
    };
  }
  return null;
}
