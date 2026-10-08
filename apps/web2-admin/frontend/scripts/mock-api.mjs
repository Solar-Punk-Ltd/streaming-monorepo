#!/usr/bin/env node
/**
 * A throwaway in-memory stand-in for the web2-admin backend, for UI work when
 * the real API (and its Postgres and Bee) are not running. It implements the
 * checkpoint-2 contract closely enough to click through every screen: cookie
 * sessions, the seeded admin user, stream CRUD, thumbnails, publish/unpublish
 * against a fake feed, and the ingest details.
 *
 * It is NOT the contract and never validates like yup does. Point the console
 * at it with these, from apps/web2-admin:
 *
 *   node frontend/scripts/mock-api.mjs
 *   VITE_WEB2_ADMIN_URL=http://localhost:9877 pnpm --filter @streaming-monorepo/web2-admin-frontend dev
 *
 * MOCK_NO_USERS=true starts with an empty users table, which is the only way
 * to see the console's "no users yet" screen and the command it prints.
 *
 * MOCK_RECORDING=true starts with one finished recording on the feed, which is
 * the only way to see the recording's details and to unpublish and publish it
 * again, since nothing here can broadcast.
 *
 * The mock holds one stage, as if a manager had pushed it, so the stream
 * form's picker and the OBS panel have something to show. MOCK_NO_STAGES=true
 * starts with none, which is the Stages page's empty state and a picker with
 * nothing to pick.
 *
 * The Funding page has a brand wallet and the mock stage's nodes, one of each
 * address state, and a send confirms a few seconds after it is made. The view
 * names the send still on its way, so a reload resumes it. The nodes hold
 * batches, one of each kind the Stamps tab shows, and a top-up or a dilution
 * confirms a few seconds after it is asked for, the stamp bulk named in the
 * view until then. MOCK_FUNDING=off answers the page as not set up, and
 * MOCK_FUNDING=refuse has the chain's node refuse every transfer at the relay,
 * which is then mined anyway, and the nodes refuse every stamp operation.
 *
 * No dependencies: plain node:http, plain node:crypto.
 */

import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

const PORT = Number(process.env.MOCK_API_PORT ?? 9877);
const COOKIE = 'web2_admin_session';

const SEED_USERNAME = process.env.SEED_ADMIN_USERNAME ?? 'admin';
let seedPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin1234';

// The mock stage runs SRS, so its record offers RTMP as every SRS stage the
// manager pushes does. MOCK_RTMP_PUBLIC=false shows the panel of a stage that
// takes SRT alone, as an OvenMediaEngine one does.
const RTMP_PUBLIC = process.env.MOCK_RTMP_PUBLIC !== 'false';

const MOCK_STAGE_ID = '5f0c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e5f';

/** The stages a manager would have pushed, as `GET /api/stages` lists them. */
const stages =
  process.env.MOCK_NO_STAGES === 'true'
    ? []
    : [
        {
          stageId: MOCK_STAGE_ID,
          name: 'Mock stage',
          kind: 'abr-uploader',
          engine: 'srs',
          supported: true,
          stackVersion: '0.0.0-mock',
          status: 'running',
          owner: '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
          ingest: {
            host: 'ingest.example.test',
            srtPort: 10061,
            rtmpPort: 10062,
            rtmpPublic: RTMP_PUBLIC,
            hasSrtPassphrase: true,
          },
          rungs: [],
          uploader: { state: 'ready', reasons: [] },
          readiness: { tone: 'ready', reasons: [] },
          // A token the manager did not generate, so the page says it is refused until it is rotated.
          adminTokenKind: 'shared',
          observedAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
          retiredAt: null,
        },
      ];

/**
 * The Funding page's API, phase 1 of docs/architecture/funding.md: the brand wallet, every stage's nodes with their
 * wallet balances, confirming their addresses, and sends from the wallet. Nothing reaches a chain. A send takes its
 * amount off the wallet at once and lands on the node when its transfer reads as confirmed, a few seconds later.
 * MOCK_FUNDING=off answers configured false, the page's "not set up" state. MOCK_FUNDING=refuse answers every
 * transfer as the chain's node refusing it at the relay, failed with no block, which frees a new send; it is mined
 * anyway when a sent one would be. MOCK_FUNDING=lost answers every transfer `unknown`, as the manager does when the
 * answer of its broadcast was lost: within the manager's 30 minutes it holds up a new send, and a few seconds later the
 * manager finds it in the pool and it turns `submitted`, then confirmed. Each item carries `settled` and `watched` by
 * the API's rules. The addresses are the repository's allow-listed fixtures.
 *
 * Phase 2, the Stamps tab: each node with a batch answers it, and the view answers today's price of postage. A stamp
 * bulk takes its items in turn, each queued until the one before it is on its way, sent, then confirmed a few seconds
 * later, when the batch gains its days or its depth and the node pays the cost and some gas. The route checks what the
 * API checks, so the page's refusals can be tried. MOCK_FUNDING=refuse has the node refuse every operation, failed
 * with a sentence, and MOCK_FUNDING=lost answers every one `unknown` first, then sent, then confirmed.
 */
const FUNDING_CONFIGURED = process.env.MOCK_FUNDING !== 'off';
const FUNDING_REFUSE = process.env.MOCK_FUNDING === 'refuse';
const FUNDING_LOST = process.env.MOCK_FUNDING === 'lost';
const FUNDING_CONFIRM_AFTER_MS = 6_000;
/** How long a `lost` transfer stays `unknown` before the manager finds it in the pool. */
const FUNDING_FOUND_AFTER_MS = 3_000;
/** The API's FUNDING_UNKNOWN_SETTLES_AFTER_MS: how long an `unknown` item holds up a new send. */
const FUNDING_UNKNOWN_SETTLES_AFTER_MS = 30 * 60 * 1000;

/** The admin's sentence for a transfer the chain's node refused at the relay. */
const FUNDING_REFUSED_AT_RELAY =
  "The chain's node refused it when the manager sent it. If it is mined anyway, this row will say so: check the node's balance before sending to it again.";
const fundingWallet = {
  address: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
  xdaiWei: 1_500_000_000_000_000_000n,
  xbzzPlur: 125_000_000_000_000_000n,
};

/** Today's price of postage as a node's chain state gives it on Gnosis Chain, with its block time and floor. */
const FUNDING_POSTAGE = { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 };
const DAY_MS = 86_400_000;
/** When the item of a stamp bulk at `index` is sent, after the one before it, and when it is confirmed after that. */
const STAMP_SEND_EVERY_MS = 2_000;
const STAMP_CONFIRM_AFTER_MS = 6_000;
/** How long a `lost` stamp operation stays `unknown` before the manager finds it on the chain. */
const STAMP_FOUND_AFTER_MS = 3_000;
/** The gas a stamp operation costs its node, in wei. */
const STAMP_GAS_WEI = 200_000_000_000_000n;
/** The sentence of a stamp operation the node refused, as MOCK_FUNDING=refuse answers every one. */
const STAMP_REFUSED = 'The node refused it, so the batch is as it was.';

/**
 * A batch as the mock holds it: what the node says of it, and when it runs out, from which its time left is worked
 * out on every read, so it shrinks as a real one does. One the node could not be read about holds only why.
 */
function fundingBatch(batchId, depth, immutable, daysLeft, fillRatio) {
  return { batchId, depth, immutable, expiresAt: Date.now() + daysLeft * DAY_MS, fillRatio, readError: null };
}

function fundingNode(nodeId, label, role, walletAddress, pinnedAddress, readError = null, batch = null) {
  return {
    nodeId,
    label,
    role,
    walletAddress,
    pinnedAddress,
    readError,
    xdaiWei: 200_000_000_000_000_000n,
    xbzzPlur: 50_000_000_000_000_000n,
    batch,
  };
}

/**
 * The catalogue node, then the mock stage's nodes: one confirmed, one new, one changed and one the manager could not
 * read, by address; and by batch, the catalogue's with 40 days, the stage's immutable one whose 30 days cost more
 * than its node holds, a rung's that no dilution leaves 7 days, an expired one, one the node could not be read about,
 * and the gateway, which has none.
 */
const fundingNodes = new Map(
  [
    fundingNode(
      'catalogue:bee-uploader',
      'catalogue-node',
      'uploader',
      '0x1234567890123456789012345678901234567890',
      '0x1234567890123456789012345678901234567890',
      null,
      fundingBatch(`0x${'c0'.repeat(32)}`, 20, false, 40, 0.12),
    ),
    fundingNode(
      `${MOCK_STAGE_ID}:bee-uploader`,
      'mock-stage-uploader',
      'uploader',
      '0x1111111111111111111111111111111111111111',
      '0x1111111111111111111111111111111111111111',
      null,
      fundingBatch(`0x${'5a'.repeat(32)}`, 22, true, 12, 0.4),
    ),
    fundingNode(
      `${MOCK_STAGE_ID}:360p`,
      'mock-pool-360p',
      'rung',
      '0x2222222222222222222222222222222222222222',
      null,
      null,
      fundingBatch(`0x${'36'.repeat(32)}`, 20, false, 10, 0.7),
    ),
    fundingNode(
      `${MOCK_STAGE_ID}:720p`,
      'mock-pool-720p',
      'rung',
      '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09',
      '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
      null,
      fundingBatch(`0x${'72'.repeat(32)}`, 20, false, 0, 0.95),
    ),
    fundingNode(
      `${MOCK_STAGE_ID}:1080p`,
      'mock-pool-1080p',
      'rung',
      '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
      '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
      null,
      { ...fundingBatch(`0x${'10'.repeat(32)}`, 20, false, 20, 0.3), readError: 'The node did not answer in time.' },
    ),
    fundingNode(`${MOCK_STAGE_ID}:gateway`, 'mock-gateway', 'gateway', null, null, 'The node did not answer.'),
  ].map((node) => [node.nodeId, node]),
);

/** bulkId -> the transfers one send asked for. */
const fundingBulks = new Map();

/** bulkId -> the top-ups or dilutions one stamp request asked for. */
const stampBulks = new Map();

/** userId -> wrong passwords in a row on the funding routes, and until when they are locked, as the API throttles them. */
const fundingFailures = new Map();
const fundingLockedUntil = new Map();

function pinOf(node) {
  if (node.pinnedAddress === null) return 'new';
  return node.pinnedAddress === node.walletAddress ? 'pinned' : 'changed';
}

/** The seconds a batch has left now, 0 once it has run out. */
function ttlOf(batch, now = Date.now()) {
  return Math.max(0, Math.floor((batch.expiresAt - now) / 1000));
}

/** A batch as the manager answers it: every reading null, and why, for one its node could not be read about. */
function batchAnswer(batch) {
  if (batch === null) return null;
  if (batch.readError) {
    return {
      batchId: batch.batchId,
      depth: null,
      immutable: null,
      usable: null,
      ttlSeconds: null,
      fillRatio: null,
      readError: batch.readError,
    };
  }
  const ttlSeconds = ttlOf(batch);
  return {
    batchId: batch.batchId,
    depth: batch.depth,
    immutable: batch.immutable,
    usable: ttlSeconds > 0,
    ttlSeconds,
    fillRatio: batch.fillRatio,
    readError: null,
  };
}

function adminFundingNode(node) {
  const read = node.walletAddress !== null;
  return {
    nodeId: node.nodeId,
    label: node.label,
    role: node.role,
    walletAddress: node.walletAddress,
    xdaiWei: read ? node.xdaiWei.toString() : null,
    xbzzPlur: read ? node.xbzzPlur.toString() : null,
    readError: node.readError,
    batch: batchAnswer(node.batch),
    pin: pinOf(node),
    pinnedAddress: node.pinnedAddress,
  };
}

/** Whether a transfer may still be mined: sent, or refused at the relay with no block. */
function fundingLandable(item) {
  return item.state === 'submitted' || (item.state === 'failed' && item.blockNumber === null);
}

/**
 * Whether an item holds up a new send, as the API decides it: queued or sent, or `unknown` and the manager answered
 * its relay at most its 30 minutes ago. The mock relays at once, so that is when it was sent.
 */
function fundingHoldsSend(item, now = Date.now()) {
  if (item.state === 'queued' || item.state === 'submitted') return true;
  return item.state === 'unknown' && now - item.sentAt <= FUNDING_UNKNOWN_SETTLES_AFTER_MS;
}

/** Turns lost transfers sent, confirms every transfer sent long enough ago, and lands its amount on its node. */
function settleFundingTransfers() {
  const now = Date.now();
  for (const items of fundingBulks.values()) {
    for (const item of items) {
      if (item.state === 'unknown' && now - item.sentAt >= FUNDING_FOUND_AFTER_MS) {
        item.state = 'submitted';
        item.watched = false;
      }
      if (!fundingLandable(item) || now - item.sentAt < FUNDING_CONFIRM_AFTER_MS) continue;
      item.state = 'confirmed';
      item.blockNumber = Math.floor(now / 5_000);
      item.error = null;
      item.watched = false;
      const node = fundingNodes.get(item.nodeId);
      if (item.kind === 'xdai') node.xdaiWei += item.amount;
      else node.xbzzPlur += item.amount;
    }
  }
}

/** The latest send with a transfer that holds up a new one, as the API names it, or null. */
function openFundingBulkId() {
  let open = null;
  for (const [bulkId, items] of fundingBulks) {
    if (items.some((item) => fundingHoldsSend(item))) open = bulkId;
  }
  return open;
}

/**
 * What a top-up of `days` costs a batch of `depth` at today's price, in PLUR, as the admin's stampQuote works it out:
 * every block of the days, rounded up, for each of the batch's 2^depth chunks.
 */
function topUpCost(days, depth) {
  const blocks = BigInt(Math.ceil((days * 86_400) / FUNDING_POSTAGE.blockSeconds));
  return blocks * BigInt(FUNDING_POSTAGE.pricePerChunkPerBlockPlur) * 2n ** BigInt(depth);
}

/** Whether a stamp operation holds up a new stamp bulk, as a transfer holds up a new send. */
function stampHoldsNext(item, now = Date.now()) {
  if (item.state === 'queued' || item.state === 'submitted') return true;
  return item.state === 'unknown' && now - item.requestedAt <= FUNDING_UNKNOWN_SETTLES_AFTER_MS;
}

/**
 * Sends each queued stamp operation in its turn, finds the lost ones, and confirms each sent long enough ago: its batch
 * gains its days, or its depth with its time left halved and its fill halved for each step, and its node pays the cost
 * and the gas.
 */
function settleStampOperations() {
  const now = Date.now();
  for (const items of stampBulks.values()) {
    for (const item of items) {
      const sentAt = item.requestedAt + item.index * STAMP_SEND_EVERY_MS;
      if (item.state === 'queued' && now >= sentAt) {
        item.state = 'submitted';
        item.txHash = `0x${hex(32)}`;
      }
      if (item.state === 'unknown' && now - sentAt >= STAMP_FOUND_AFTER_MS) {
        item.state = 'submitted';
        item.watched = false;
      }
      if (item.state !== 'submitted' || now - sentAt < STAMP_CONFIRM_AFTER_MS) continue;
      item.state = 'confirmed';
      const node = fundingNodes.get(item.nodeId);
      const batch = node.batch;
      if (item.kind === 'topup') {
        batch.expiresAt += item.days * DAY_MS;
        node.xbzzPlur -= item.cost;
      } else {
        const scale = 2 ** item.steps;
        batch.depth += item.steps;
        batch.expiresAt = now + Math.max(0, batch.expiresAt - now) / scale;
        batch.fillRatio /= scale;
      }
      node.xdaiWei = node.xdaiWei > STAMP_GAS_WEI ? node.xdaiWei - STAMP_GAS_WEI : 0n;
    }
  }
}

/** The latest stamp bulk with an operation that holds up a new one, as the API names it, or null. */
function openStampBulkId() {
  let open = null;
  for (const [bulkId, items] of stampBulks) {
    if (items.some((item) => stampHoldsNext(item))) open = bulkId;
  }
  return open;
}

/** A stamp operation as the API answers it, on the request and on every read. */
function stampItemAnswer(item) {
  return {
    requestId: item.requestId,
    kind: item.kind,
    nodeId: item.nodeId,
    nodeLabel: item.nodeLabel,
    batchId: item.batchId,
    days: item.kind === 'topup' ? item.days : null,
    steps: item.kind === 'dilute' ? item.steps : null,
    costPlur: item.kind === 'topup' ? item.cost.toString() : null,
    state: item.state,
    txHash: item.txHash,
    error: item.error,
    settled: !stampHoldsNext(item),
    watched: item.watched,
  };
}

/**
 * Why the mock refuses a stamp request, as the API checks one, or null: one kind, each batch once, each the batch of
 * its node, read, usable and at the depth the page saw; whole days of 1 or more; 1 or 2 steps that leave 7 days; every
 * node's xBZZ covering its top-ups and some xDAI for the gas.
 */
function stampRefusal(asked) {
  if (asked.length === 0) return 'Tick a batch first.';
  if (new Set(asked.map((item) => item?.kind)).size !== 1) return 'A stamp request takes one kind of operation.';
  if (new Set(asked.map((item) => item?.batchId)).size !== asked.length) return 'A batch is named twice.';
  const costs = new Map();
  for (const item of asked) {
    const node = fundingNodes.get(item?.nodeId);
    const batch = node?.batch;
    if (!batch || batch.batchId !== item.batchId) return `${item?.batchId} is not the batch of ${item?.nodeId}.`;
    if (batch.readError || ttlOf(batch) === 0) return `The batch of ${node.label} cannot take it now.`;
    if (batch.depth !== item.expectedDepth) {
      return `The batch of ${node.label} is at depth ${batch.depth} now, not ${item.expectedDepth}.`;
    }
    if (item.kind === 'topup') {
      if (!Number.isSafeInteger(item.days) || item.days < 1) return 'The days are a whole number, 1 or more.';
      costs.set(node, (costs.get(node) ?? 0n) + topUpCost(item.days, batch.depth));
    } else if (item.kind === 'dilute') {
      if (item.steps !== 1 && item.steps !== 2) return 'A dilution takes 1 or 2 steps.';
      if (ttlOf(batch) / 2 ** item.steps < 7 * 86_400) return `It would leave the batch of ${node.label} under 7 days.`;
    } else {
      return 'An operation is a top-up or a dilution.';
    }
    if (node.xdaiWei === 0n) return `${node.label} holds no xDAI to pay the gas.`;
  }
  for (const [node, cost] of costs) {
    if (cost > node.xbzzPlur) return `${node.label} holds less xBZZ than its top-ups cost.`;
  }
  return null;
}

function fundingView() {
  const observedAt = new Date().toISOString();
  if (!FUNDING_CONFIGURED) {
    return {
      configured: false,
      wallet: null,
      chainId: 100,
      stages: [],
      catalogue: null,
      postage: null,
      observedAt,
      managerError: null,
      openBulkId: null,
      openStampBulkId: null,
    };
  }
  settleFundingTransfers();
  settleStampOperations();
  const nodesOf = (stageId) => [...fundingNodes.values()].filter((node) => node.nodeId.startsWith(`${stageId}:`));
  return {
    configured: true,
    wallet: {
      address: fundingWallet.address,
      xdaiWei: fundingWallet.xdaiWei.toString(),
      xbzzPlur: fundingWallet.xbzzPlur.toString(),
    },
    chainId: 100,
    stages: stages.map((stage) => ({
      stageId: stage.stageId,
      name: stage.name,
      nodes: nodesOf(stage.stageId).map(adminFundingNode),
    })),
    catalogue: adminFundingNode(fundingNodes.get('catalogue:bee-uploader')),
    postage: FUNDING_POSTAGE,
    observedAt,
    managerError: null,
    openBulkId: openFundingBulkId(),
    openStampBulkId: openStampBulkId(),
  };
}

/**
 * An item as the API answers it, on the send and on every read: its block number is null until it is mined, `settled`
 * is false while it holds up a new send, and `watched` is true while it is `unknown`, or failed at the relay with no
 * block, and still asked about.
 */
function fundingItemAnswer(item) {
  return {
    requestId: item.requestId,
    nodeId: item.nodeId,
    kind: item.kind,
    amount: item.amount.toString(),
    state: item.state,
    txHash: item.txHash,
    blockNumber: item.blockNumber,
    error: item.error,
    settled: !fundingHoldsSend(item),
    watched: item.watched,
  };
}

/** A stage a stream may be put on, as the API decides it: known, not retired, supported. */
function assignable(stageId) {
  return stages.some((stage) => stage.stageId === stageId && stage.retiredAt === null && stage.supported);
}

const OWNER = '1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c';
const FEED_TOPIC = 'swarm-stream';
const FEED_TOPIC_HEX = '4c4b1a0d9e5b1f7a3c2d8e6f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3';

/**
 * The users the mock knows. `MOCK_NO_USERS=true` starts with none, which is
 * the only way to see the console's "no users yet" screen and the command it
 * prints.
 */
const users = new Map();
const passwords = new Map();

function makeUser(username, password, isAdmin) {
  const row = {
    id: randomUUID(),
    username,
    isAdmin,
    createdAt: new Date().toISOString(),
    passwordChangedAt: null,
    lastLoginAt: null,
  };
  users.set(row.id, row);
  passwords.set(row.id, password);
  return row;
}

if (process.env.MOCK_NO_USERS !== 'true') {
  makeUser(SEED_USERNAME, seedPassword, true);
}

function byUsername(username) {
  return [...users.values()].find((u) => u.username === username) ?? null;
}

/** username -> consecutive failures, for the lockout the real API keeps. */
const failures = new Map();
const LOCKOUT_FREE_ATTEMPTS = 4;
const LOCKOUT_SECONDS = 60;

/** token -> userId */
const sessions = new Map();
/** id -> stream row (plus the thumbnail bytes, which the API never returns) */
const streams = new Map();
let feedIndex = -1;
let feedEntries = 0;

function hex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readCookie(req) {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

/** The signed-in user, or null. */
function currentUser(req) {
  const token = readCookie(req);
  if (token === null) return null;
  return users.get(sessions.get(token)) ?? null;
}

function sessionCount(userId) {
  return [...sessions.values()].filter((id) => id === userId).length;
}

function summarise(row) {
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    sessions: sessionCount(row.id),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

/** The statuses whose stream has an entry on the catalogue. */
const ON_FEED_STATUSES = ['published', 'live', 'vod'];

function publicStream(row) {
  const { thumbnail, thumbnailMime, editsNotOnFeed, ...rest } = row;
  return {
    ...rest,
    hasThumbnail: thumbnail !== null && thumbnailMime !== null,
    hasUnpublishedEdits: editsNotOnFeed && ON_FEED_STATUSES.includes(row.status),
  };
}

function ingestDetails(row) {
  const streamId = `${row.mediaType}/${row.topic}`;
  const stage = stages.find((candidate) => candidate.stageId === row.stageId);
  const own = {
    streamId,
    app: row.mediaType,
    stream: row.topic,
    publishKey: row.publishKey,
    publishKeyRotatedAt: row.publishKeyRotatedAt,
  };
  if (!stage) return { ...own, stage: null, srt: null, rtmp: null };
  const { host, srtPort, rtmpPort, rtmpPublic } = stage.ingest;
  return {
    ...own,
    stage: { stageId: stage.stageId, name: stage.name, retiredAt: stage.retiredAt },
    srt: {
      url: `srt://${host}:${srtPort}?streamid=#!::r=${streamId}?key=${row.publishKey},m=publish`,
      passphrase: 'mock-srt-passphrase-value',
    },
    rtmp: rtmpPublic
      ? {
          server: `rtmp://${host}:${rtmpPort}/${row.mediaType}`,
          streamKey: `${row.topic}?key=${row.publishKey}`,
        }
      : null,
  };
}

/** What the catalogue entry carries of a stream's own fields. */
function entryContent(row) {
  return JSON.stringify([row.title, row.description, row.tags, row.mediaType, row.scheduledStartTime]);
}

/**
 * Like the API, a save that changes nothing is not an edit: the console PUTs
 * the whole form back every time.
 */
function applyInput(row, input) {
  const before = entryContent(row);
  row.title = String(input.title ?? '');
  row.description = String(input.description ?? '');
  row.tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
  row.mediaType = input.mediaType === 'audio' ? 'audio' : 'video';
  row.scheduledStartTime = input.scheduledStartTime ?? null;
  if (input.stageId !== undefined) row.stageId = input.stageId;
  row.updatedAt = new Date().toISOString();
  if (entryContent(row) !== before) row.editsNotOnFeed = true;
}

function newStream(input) {
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    topic: randomUUID(),
    owner: OWNER,
    title: '',
    description: '',
    tags: [],
    mediaType: 'video',
    scheduledStartTime: null,
    thumbnail: null,
    thumbnailMime: null,
    thumbnailRef: null,
    status: 'draft',
    publishedAt: null,
    publishedFeedIndex: null,
    publishError: null,
    publishKey: hex(16),
    publishKeyRotatedAt: null,
    // What the uploader reports. Only the MOCK_RECORDING seed sets them.
    manifestIndex: null,
    durationSeconds: null,
    liveSince: null,
    endedAt: null,
    // Stands in for the API's two timestamps: an edit the catalogue entry
    // does not carry yet. Cleared by a publish, which rebuilds the entry.
    editsNotOnFeed: false,
    stageId: null,
    createdAt: now,
    updatedAt: now,
  };
  applyInput(row, input);
  row.editsNotOnFeed = false;
  return row;
}

/** `written` is whether the call wrote the feed, as the API answers it. */
function publishResult(row, written) {
  return {
    stream: publicStream(row),
    feed: {
      owner: OWNER,
      topic: FEED_TOPIC,
      topicHex: FEED_TOPIC_HEX,
      index: feedIndex,
      entryCount: feedEntries,
    },
    written,
  };
}

if (process.env.MOCK_RECORDING === 'true') {
  const row = newStream({
    title: 'A finished broadcast',
    description: 'Seeded by MOCK_RECORDING: a recording already on the feed.',
    tags: ['mock'],
    mediaType: 'video',
    scheduledStartTime: '2026-09-11T10:00:00.000Z',
  });
  feedIndex += 1;
  feedEntries += 1;
  Object.assign(row, {
    status: 'vod',
    publishedAt: '2026-09-11T09:00:00.000Z',
    publishedFeedIndex: feedIndex,
    manifestIndex: 412,
    durationSeconds: 3540,
    liveSince: '2026-09-11T10:01:00.000Z',
    endedAt: '2026-09-11T11:00:00.000Z',
    stageId: stages[0]?.stageId ?? null,
  });
  streams.set(row.id, row);
}

function stageUnavailable(res, stageId) {
  return send(res, 409, {
    error: 'stage_unavailable',
    stageId,
    reason: 'unknown',
    message: 'The admin knows no stage with that id. Pick one of the stages listed.',
  });
}

const server = createServer((req, res) => {
  void handle(req, res).catch((e) => {
    send(res, 500, { error: 'internal_error', message: String(e) });
  });
});

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/api/health') return send(res, 200, { status: 'ok' });

  if (path === '/api/config') {
    return send(res, 200, {
      feed: { owner: OWNER, topic: FEED_TOPIC, topicHex: FEED_TOPIC_HEX },
      viewerBaseUrl: process.env.VIEWER_BASE_URL ?? 'http://localhost:10074',
    });
  }

  // Every write must carry the header no cross-origin page can add without a
  // preflight this mock, like the API, never answers.
  if (method !== 'GET' && method !== 'HEAD' && req.headers['x-requested-with'] !== 'web2-admin') {
    return send(res, 403, { error: 'cross_site_request' });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    if (users.size === 0) return send(res, 401, { error: 'no_users' });

    const name = String(body.username ?? '');
    if ((failures.get(name) ?? 0) > LOCKOUT_FREE_ATTEMPTS) {
      return send(
        res,
        429,
        { error: 'too_many_attempts', retryAfterSeconds: LOCKOUT_SECONDS },
        { 'retry-after': String(LOCKOUT_SECONDS) },
      );
    }

    const row = byUsername(name);
    if (row === null || passwords.get(row.id) !== body.password) {
      failures.set(name, (failures.get(name) ?? 0) + 1);
      return send(res, 401, { error: 'invalid_credentials' });
    }

    failures.delete(name);
    row.lastLoginAt = new Date().toISOString();
    const token = hex(24);
    sessions.set(token, row.id);
    return send(
      res,
      200,
      { user: row },
      {
        'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      },
    );
  }

  // Public: the console asks this on boot, and a 401 here is an answer.
  if (path === '/api/auth/session') {
    const me = currentUser(req);
    if (me) return send(res, 200, { user: me });
    return send(res, 401, {
      error: users.size === 0 ? 'no_users' : 'unauthenticated',
    });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = readCookie(req);
    if (token) sessions.delete(token);
    res.writeHead(204, {
      'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    });
    return res.end();
  }

  // Everything below needs a session.
  const user = currentUser(req);
  if (user === null) return send(res, 401, { error: 'unauthenticated' });

  // Nothing deployed this, so it is what the API answers outside a deploy: a development build.
  if (path === '/api/version' && method === 'GET') return send(res, 200, { label: null, commit: null });

  if (path === '/api/auth/users' && method === 'GET') {
    return send(res, 200, { users: [...users.values()].map(summarise) });
  }

  if (path === '/api/auth/users' && method === 'POST') {
    if (!user.isAdmin) return send(res, 403, { error: 'admin_required' });
    const body = await readJson(req);
    if (byUsername(body.username)) {
      return send(res, 409, { error: 'user_exists' });
    }
    const added = makeUser(String(body.username), String(body.password), body.admin === true);
    return send(res, 201, { user: added });
  }

  const userRoute = /^\/api\/auth\/users\/([^/]+)(\/revoke)?$/.exec(path);
  if (userRoute) {
    const target = users.get(userRoute[1]);
    if (!target) return send(res, 404, { error: 'user_not_found' });

    if (userRoute[2] && method === 'POST') {
      if (!user.isAdmin && target.id !== user.id) {
        return send(res, 403, { error: 'admin_required' });
      }
      for (const [token, id] of [...sessions.entries()]) {
        if (id === target.id) sessions.delete(token);
      }
      res.writeHead(204);
      return res.end();
    }

    if (!userRoute[2] && method === 'DELETE') {
      if (!user.isAdmin) return send(res, 403, { error: 'admin_required' });
      const admins = [...users.values()].filter((u) => u.isAdmin).length;
      if (target.id === user.id || users.size <= 1 || (target.isAdmin && admins <= 1)) {
        return send(res, 409, { error: 'cannot_remove_user' });
      }
      users.delete(target.id);
      passwords.delete(target.id);
      for (const [token, id] of [...sessions.entries()]) {
        if (id === target.id) sessions.delete(token);
      }
      res.writeHead(204);
      return res.end();
    }
  }

  if (path === '/api/auth/password' && method === 'POST') {
    const body = await readJson(req);
    if (passwords.get(user.id) !== body.currentPassword) {
      return send(res, 401, { error: 'invalid_credentials' });
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 12) {
      return send(res, 400, {
        error: 'validation_error',
        errors: ['password must be at least 12 characters'],
      });
    }
    passwords.set(user.id, body.newPassword);
    if (user.username === SEED_USERNAME) seedPassword = body.newPassword;
    user.passwordChangedAt = new Date().toISOString();
    // Every other session of this user goes away; keep the caller's.
    const keep = readCookie(req);
    for (const [token, id] of [...sessions.entries()]) {
      if (id === user.id && token !== keep) sessions.delete(token);
    }
    return send(res, 200, { user });
  }

  if (path === '/api/funding' && method === 'GET') return send(res, 200, fundingView());

  if (path === '/api/funding/transfers' && method === 'GET') {
    const items = fundingBulks.get(url.searchParams.get('bulkId') ?? '');
    if (!items) return send(res, 404, { error: 'not_found', path });
    settleFundingTransfers();
    return send(res, 200, { items: items.map(fundingItemAnswer) });
  }

  if (path === '/api/funding/stamp-operations' && method === 'GET') {
    const items = stampBulks.get(url.searchParams.get('bulkId') ?? '');
    if (!items) return send(res, 404, { error: 'not_found', path });
    settleStampOperations();
    return send(res, 200, { items: items.map(stampItemAnswer) });
  }

  // No password: a stamp operation pays from the nodes' own wallets, so the page asks in a confirm dialog alone. One
  // stamp bulk at a time, as the API has it, whatever a send of the brand wallet is doing.
  if (path === '/api/funding/stamp-operations' && method === 'POST') {
    if (!FUNDING_CONFIGURED) return send(res, 404, { error: 'not_found', path });
    const body = await readJson(req);
    settleStampOperations();
    if (openStampBulkId() !== null) {
      return send(res, 409, { error: 'conflict', message: 'An earlier stamp bulk has not settled yet.' });
    }
    const asked = Array.isArray(body.items) ? body.items : [];
    const refusal = stampRefusal(asked);
    if (refusal) return send(res, 422, { error: 'stamp_refused', message: refusal });
    const bulkId = randomUUID();
    const requestedAt = Date.now();
    const items = asked.map((item, index) => {
      const node = fundingNodes.get(item.nodeId);
      return {
        requestId: randomUUID(),
        index,
        kind: item.kind,
        nodeId: node.nodeId,
        nodeLabel: node.label,
        batchId: item.batchId,
        days: item.kind === 'topup' ? item.days : null,
        steps: item.kind === 'dilute' ? item.steps : null,
        cost: item.kind === 'topup' ? topUpCost(item.days, node.batch.depth) : 0n,
        state: FUNDING_REFUSE ? 'failed' : FUNDING_LOST ? 'unknown' : 'queued',
        txHash: FUNDING_LOST ? `0x${hex(32)}` : null,
        error: FUNDING_REFUSE ? STAMP_REFUSED : null,
        watched: FUNDING_LOST,
        requestedAt,
      };
    });
    stampBulks.set(bulkId, items);
    settleStampOperations();
    return send(res, 202, { bulkId, items: items.map(stampItemAnswer) });
  }

  if ((path === '/api/funding/pins' || path === '/api/funding/transfers') && method === 'POST') {
    if (!FUNDING_CONFIGURED) return send(res, 404, { error: 'not_found', path });
    const body = await readJson(req);
    const lockedFor = Math.ceil(((fundingLockedUntil.get(user.id) ?? 0) - Date.now()) / 1000);
    if (lockedFor > 0) {
      return send(
        res,
        429,
        { error: 'too_many_attempts', retryAfterSeconds: lockedFor },
        { 'retry-after': String(lockedFor) },
      );
    }
    if (passwords.get(user.id) !== body.password) {
      const failed = (fundingFailures.get(user.id) ?? 0) + 1;
      fundingFailures.set(user.id, failed);
      if (failed >= LOCKOUT_FREE_ATTEMPTS) {
        fundingFailures.delete(user.id);
        fundingLockedUntil.set(user.id, Date.now() + LOCKOUT_SECONDS * 1000);
      }
      return send(res, 401, { error: 'invalid_credentials' });
    }
    fundingFailures.delete(user.id);

    if (path === '/api/funding/pins') {
      const ids = Array.isArray(body.nodeIds) ? body.nodeIds : [];
      const nodes = ids.map((id) => fundingNodes.get(id));
      if (nodes.length === 0 || nodes.some((node) => !node || node.walletAddress === null)) {
        return send(res, 400, { error: 'validation_error', errors: ['nodeIds must name nodes with a wallet address'] });
      }
      for (const node of nodes) node.pinnedAddress = node.walletAddress;
      return send(res, 200, { pinned: ids });
    }

    // One send at a time: a second one while an earlier one still holds it up is refused, as the API refuses it. A
    // transfer refused at the relay holds up no send; one not known yet does, for the manager's 30 minutes.
    settleFundingTransfers();
    if (openFundingBulkId() !== null) {
      return send(res, 409, { error: 'conflict', message: 'An earlier send has not settled yet.' });
    }
    const asked = Array.isArray(body.items) ? body.items : [];
    const valid = asked.every(
      (item) =>
        fundingNodes.has(item?.nodeId) && ['xdai', 'xbzz'].includes(item.kind) && /^[1-9]\d*$/.test(item.amount),
    );
    if (asked.length === 0 || !valid) {
      return send(res, 400, {
        error: 'validation_error',
        errors: ['items must name nodes, a kind and an amount in base units'],
      });
    }
    const unpinned = asked.map((item) => fundingNodes.get(item.nodeId)).find((node) => pinOf(node) !== 'pinned');
    if (unpinned) {
      return send(res, 409, { error: 'node_not_pinned', message: `Confirm the address of ${unpinned.label} first.` });
    }
    const total = (kind) =>
      asked.filter((item) => item.kind === kind).reduce((sum, item) => sum + BigInt(item.amount), 0n);
    if (total('xdai') > fundingWallet.xdaiWei || total('xbzz') > fundingWallet.xbzzPlur) {
      return send(res, 409, { error: 'insufficient_balance', message: 'That is more than the brand wallet holds.' });
    }
    fundingWallet.xdaiWei -= total('xdai');
    fundingWallet.xbzzPlur -= total('xbzz');
    const bulkId = randomUUID();
    const items = asked.map((item) => ({
      requestId: randomUUID(),
      nodeId: item.nodeId,
      kind: item.kind,
      amount: BigInt(item.amount),
      state: FUNDING_REFUSE ? 'failed' : FUNDING_LOST ? 'unknown' : 'submitted',
      txHash: `0x${hex(32)}`,
      blockNumber: null,
      error: FUNDING_REFUSE ? FUNDING_REFUSED_AT_RELAY : null,
      watched: FUNDING_REFUSE || FUNDING_LOST,
      sentAt: Date.now(),
    }));
    fundingBulks.set(bulkId, items);
    return send(res, 202, { bulkId, items: items.map(fundingItemAnswer) });
  }

  // No manager pushes into the mock, so its stages are fixed and it has no
  // catalogue stamp. It publishes anyway, as the API does with
  // FEED_GATEWAY=fake, so My Streams shows no refusal.
  if (path === '/api/stages' && method === 'GET') return send(res, 200, { stages });
  if (path === '/api/catalogue-stamp' && method === 'GET') {
    return send(res, 200, {
      catalogueStamp: null,
      catalogueWrite: { batch: null, refusal: null, moveWaitingTo: null, unrecordedHistory: null },
      // Nothing to move without a catalogue stamp, and the move is off by default, as CATALOGUE_MOVE_ENABLED is.
      catalogueMove: {
        enabled: false,
        waiting: null,
        refusal: null,
        latest: null,
        designatedBatchId: null,
        pinnedBatchId: null,
      },
    });
  }

  if (path === '/api/streams' && method === 'GET') {
    const list = [...streams.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicStream);
    return send(res, 200, { streams: list });
  }

  if (path === '/api/streams' && method === 'POST') {
    const input = await readJson(req);
    if (input.stageId && !assignable(input.stageId)) return stageUnavailable(res, input.stageId);
    const row = newStream(input);
    streams.set(row.id, row);
    return send(res, 201, publicStream(row));
  }

  const match = /^\/api\/streams\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) return send(res, 404, { error: 'not_found', path });

  const row = streams.get(match[1]);
  if (!row) return send(res, 404, { error: 'not_found', path });
  const sub = match[2] ?? '';

  if (sub === '' && method === 'GET') return send(res, 200, publicStream(row));

  if (sub === '' && method === 'PUT') {
    if (row.status === 'publishing') return send(res, 409, { error: 'stream_busy' });
    const input = await readJson(req);
    // The API's stage rules, without the race it also guards against.
    if (input.stageId !== undefined && input.stageId !== row.stageId) {
      if (row.status !== 'draft') {
        return send(res, 409, {
          error: 'stage_locked',
          reason: 'published',
          message: 'Unpublish the stream to change its stage; publishing fixed it.',
        });
      }
      if (row.manifestIndex !== null && row.stageId !== null) {
        return send(res, 409, {
          error: 'stage_locked',
          reason: 'recording',
          message: 'This stream holds a recording made on its stage, so it keeps that stage.',
        });
      }
      if (input.stageId && !assignable(input.stageId)) return stageUnavailable(res, input.stageId);
    }
    applyInput(row, input);
    return send(res, 200, publicStream(row));
  }

  if (sub === '' && method === 'DELETE') {
    if (row.status === 'live') return send(res, 409, { error: 'stream_live' });
    if (ON_FEED_STATUSES.includes(row.status)) {
      return send(res, 409, { error: 'stream_published' });
    }
    streams.delete(row.id);
    res.writeHead(204);
    return res.end();
  }

  if (sub === '/thumbnail' && method === 'PUT') {
    const mime = String(req.headers['content-type'] ?? '');
    if (!mime.startsWith('image/')) {
      return send(res, 415, { error: 'unsupported_media_type' });
    }
    const bytes = await readBody(req);
    if (bytes.length > 5 * 1024 * 1024) {
      return send(res, 413, { error: 'payload_too_large' });
    }
    row.thumbnail = bytes;
    row.thumbnailMime = mime;
    // A new image invalidates whatever was uploaded to Swarm before.
    row.thumbnailRef = null;
    row.editsNotOnFeed = true;
    row.updatedAt = new Date().toISOString();
    return send(res, 200, publicStream(row));
  }

  if (sub === '/thumbnail' && method === 'GET') {
    if (!row.thumbnail) return send(res, 404, { error: 'not_found', path });
    res.writeHead(200, {
      'content-type': row.thumbnailMime,
      'content-length': row.thumbnail.length,
      'cache-control': 'no-cache',
    });
    return res.end(row.thumbnail);
  }

  if (sub === '/thumbnail' && method === 'DELETE') {
    if (row.thumbnail) row.editsNotOnFeed = true;
    row.thumbnail = null;
    row.thumbnailMime = null;
    row.thumbnailRef = null;
    row.updatedAt = new Date().toISOString();
    return send(res, 200, publicStream(row));
  }

  if (sub === '/publish' && method === 'POST') {
    if (row.status === 'publishing') {
      return send(res, 409, { error: 'stream_busy' });
    }
    if (row.status === 'draft' && !row.stageId) {
      return send(res, 409, {
        error: 'stage_required',
        id: row.id,
        message: 'Pick the stage this stream is broadcast on before publishing.',
      });
    }
    // Like the API: a stream on the catalogue with no edit its entry lacks,
    // and no failed attempt behind it, has nothing to write.
    const written = !ON_FEED_STATUSES.includes(row.status) || row.editsNotOnFeed || row.publishError !== null;
    if (!ON_FEED_STATUSES.includes(row.status)) feedEntries += 1;
    if (written) feedIndex += 1;
    if (row.thumbnail && !row.thumbnailRef) row.thumbnailRef = hex(32);
    const now = new Date().toISOString();
    // Like the API: a live or recorded stream keeps its state, and a draft
    // that still holds a recording goes back on the feed as that recording.
    if (row.status === 'draft' || row.status === 'published') {
      row.status = row.manifestIndex !== null ? 'vod' : 'published';
      row.publishedAt = now;
    }
    row.publishedFeedIndex = feedIndex;
    row.publishError = null;
    row.editsNotOnFeed = false;
    row.updatedAt = now;
    return send(res, 200, publishResult(row, written));
  }

  if (sub === '/unpublish' && method === 'POST') {
    if (row.status === 'live') return send(res, 409, { error: 'stream_live' });
    const written = ON_FEED_STATUSES.includes(row.status);
    if (written) {
      feedEntries = Math.max(0, feedEntries - 1);
      feedIndex += 1;
    }
    // Off the feed and back to a draft, keeping the recording, as the API does.
    row.status = 'draft';
    row.publishedAt = null;
    row.publishedFeedIndex = null;
    row.updatedAt = new Date().toISOString();
    return send(res, 200, publishResult(row, written));
  }

  if (sub === '/ingest' && method === 'GET') {
    return send(res, 200, ingestDetails(row));
  }

  if (sub === '/ingest/rotate-key' && method === 'POST') {
    row.publishKey = hex(16);
    row.publishKeyRotatedAt = new Date().toISOString();
    row.updatedAt = row.publishKeyRotatedAt;
    return send(res, 200, ingestDetails(row));
  }

  return send(res, 404, { error: 'not_found', path });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-api] listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-api] log in as ${SEED_USERNAME} / ${seedPassword}`);
  console.log(`[mock-api] MOCK_RTMP_PUBLIC=${RTMP_PUBLIC}`);
  console.log(
    `[mock-api] stages: ${stages.length === 0 ? 'none (MOCK_NO_STAGES)' : stages.map((stage) => stage.name).join(', ')}`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
