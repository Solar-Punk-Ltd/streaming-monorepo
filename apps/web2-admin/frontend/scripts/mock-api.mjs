#!/usr/bin/env node
/**
 * A throwaway in-memory stand-in for the web2-admin backend, for UI work when
 * the real API (and its Postgres and Bee) are not running. It implements enough
 * of the API to click through every screen: cookie sessions, the seeded admin
 * user, stream CRUD, thumbnails, publish/unpublish against a fake feed, the
 * ingest details, the stages, the catalogue stamp and its move, the Funding
 * page's three tabs, the build line and the host's look.
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
 * MOCK_RECORDING=true adds one more recording on the feed, one that ended weeks
 * before, so it is finalized at start like the oldest of the seeded streams.
 *
 * Every start seeds three published streams, one in each state the stream page
 * tells apart once a stream has gone live: one live now, one that ended five
 * minutes before the mock started and can go live again for the rest of its
 * restart window, and one that ended three days before, whose window ran out,
 * so it is finalized and its key has changed. As the API does with its default
 * STREAM_RESTART_WINDOW_MINUTES, the mock finalizes a recording, with a new
 * key, once 30 minutes have passed since it ended, and Finalize does it at once
 * on a recording. A live stream is refused, as the API refuses it.
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
 * view until then. They hold chequebooks too, one of each kind the Chequebooks
 * tab shows, and a deposit or a withdrawal is mined two seconds after it is
 * sent and confirmed six seconds after that, once its block is final, the
 * chequebook bulk named in the view until then.
 * The host's default look is MOCK_DEFAULT_THEME, `swarm` when unset.
 *
 * MOCK_ARCHIVE_STAMPS decides the archive stamps, as below at its constants:
 * `some`, the default, three on the catalogue node; `none`, none yet;
 * `buying`, a purchase on its way too; `left`, one more left on a node that
 * is the catalogue node no longer; `unoffered`, a purchase route that answers
 * as a manager that offers no purchases.
 *
 * MOCK_FUNDING=off answers the page as not set up, and MOCK_FUNDING=refuse has
 * the chain's node refuse every transfer at the relay, which is then mined
 * anyway, and the nodes refuse every stamp and chequebook operation.
 *
 * Exporting a recording works as the API holds it: one export at a time, read
 * for 45 seconds and joined for 5, then kept until the next one starts. Every
 * start seeds one, of the first seeded recording, MOCK_EXPORT deciding which: `running`, the default, is a 720p export another user started, so the
 * widget shows it moving; `paused` is one the seeded user started, which pauses
 * at once on segments it could not read, so the panel comes to front, and every
 * export started from the panel pauses the same way part-way; `done` is a kept
 * file; `off` seeds none. Save file answers a stand-in file, not a video.
 *
 * Archiving a recording works as the API holds it: one archive at a time,
 * which shares the place a job has with the export. It measures for 6 seconds,
 * copies for 60 and verifies for 8; a new stamp is bought in 6 and usable 6
 * later. MOCK_ARCHIVE decides the archive seeded at start, of the first seeded
 * recording, with the values of `src/components/archive/archiveSeams.ts`: `off`,
 * the default, seeds none. Four more recordings are seeded whichever is set, so
 * the recordings carry an archive of each state the stream list tells apart.
 *
 * No dependencies: plain node:http, plain node:crypto.
 */

import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

const PORT = Number(process.env.MOCK_API_PORT ?? 9877);
const COOKIE = 'web2_admin_session';

const SEED_USERNAME = process.env.SEED_ADMIN_USERNAME ?? 'admin';
let seedPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin1234';

const MOCK_STAGE_ID = '5f0c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e5f';

/** The look this host's console starts in, as `GET /api/config` answers it. Never checked. */
const defaultTheme = process.env.MOCK_DEFAULT_THEME ?? 'swarm';

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
            rtmpPublic: true,
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
 * The Funding page's wallet API (docs/architecture/funding.md): the brand wallet, every stage's nodes with their
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
 *
 * Phase 3, the Chequebooks tab: each stage node answers its chequebook, or none, or why it could not be read about it.
 * A chequebook bulk names a target and, for each chequebook, the available balance the page showed, from which and the
 * balance the chequebook holds then the mock works out each move again as the API does, never more than the page
 * showed: a deposit of the difference from the node's wallet under the target, a withdrawal of the difference into it
 * over the target. It takes the moves in turn as a stamp bulk takes its operations; each is answered `mined` two seconds
 * after it is sent and confirmed six seconds after that, once its block is final, as the manager confirms a chequebook
 * move, and once one is confirmed the chequebook and the wallet hold their new balances and the node pays some gas.
 * The route checks what the API checks, refusing with its sentence. MOCK_FUNDING=refuse and MOCK_FUNDING=lost answer
 * chequebook operations as they answer stamp operations.
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
/** The least target a chequebook bulk takes, 1 xBZZ, in PLUR, as the common CHEQUEBOOK_TARGET_MIN_PLUR. */
const CHEQUEBOOK_TARGET_MIN_PLUR = 10_000_000_000_000_000n;
/**
 * When the move of a chequebook bulk at `index` is sent, after the one before it; when it is mined, after it is sent;
 * and when it is confirmed, its block final, after it is mined. The manager confirms a chequebook move only once its
 * block is final, about 3 minutes after it is mined on Gnosis Chain, which the mock shortens to six seconds.
 */
const CHEQUEBOOK_SEND_EVERY_MS = 2_000;
const CHEQUEBOOK_MINED_AFTER_MS = 2_000;
const CHEQUEBOOK_FINAL_AFTER_MS = 6_000;
/** How long a `lost` chequebook operation stays `unknown` before the manager finds it on the chain. */
const CHEQUEBOOK_FOUND_AFTER_MS = 3_000;
/** The gas a chequebook operation costs its node, in wei. */
const CHEQUEBOOK_GAS_WEI = 150_000_000_000_000n;
/** The sentence of a chequebook operation the node refused, as MOCK_FUNDING=refuse answers every one. */
const CHEQUEBOOK_REFUSED = 'The node refused it, so its chequebook is as it was.';
/** The repository's allow-listed fixture address, which every mock chequebook answers as its own. */
const CHEQUEBOOK_ADDRESS = '0x3333333333333333333333333333333333333333';
/** One xBZZ, in PLUR. */
const XBZZ = 10_000_000_000_000_000n;

/**
 * A batch as the mock holds it: what the node says of it, and when it runs out, from which its time left is worked
 * out on every read, so it shrinks as a real one does. One the node could not be read about holds only why.
 */
function fundingBatch(batchId, depth, immutable, daysLeft, fillRatio) {
  return { batchId, depth, immutable, expiresAt: Date.now() + daysLeft * DAY_MS, fillRatio, readError: null };
}

/**
 * A chequebook as the mock holds it: its balances in PLUR, BigInt, or, for one its node could not be read about, no
 * balances and why.
 */
function fundingChequebook(availablePlur, totalPlur, readError = null) {
  return { address: CHEQUEBOOK_ADDRESS, availablePlur, totalPlur, readError };
}

function fundingNode(
  nodeId,
  label,
  role,
  walletAddress,
  pinnedAddress,
  readError = null,
  batch = null,
  chequebook = null,
) {
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
    chequebook,
  };
}

/**
 * The catalogue node, then the mock stage's nodes: one confirmed, one new, one changed and one the manager could not
 * read, by address; and by batch, the catalogue's with 40 days, the stage's immutable one whose 30 days cost more
 * than its node holds, a rung's that no dilution leaves 7 days, an expired one, one the node could not be read about,
 * and the gateways, which have none. By chequebook, against a target of 2 xBZZ: the stage's own node's, 0.4 xBZZ,
 * under it, whose node cannot pay a deposit to a target over 5.4 xBZZ; a rung's, every digit of 3.1234567890123456
 * xBZZ, over it; a rung's at it, whose node holds no xDAI for the gas of a move to another target; a rung's its node
 * could not be read about; the light gateway's, which the tab shows read-only; and the other gateway, an ultra-light
 * node, with none. The catalogue node's chequebook, 1 xBZZ, is listed first.
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
      fundingChequebook(XBZZ, XBZZ),
    ),
    fundingNode(
      `${MOCK_STAGE_ID}:bee-uploader`,
      'mock-stage-uploader',
      'uploader',
      '0x1111111111111111111111111111111111111111',
      '0x1111111111111111111111111111111111111111',
      null,
      fundingBatch(`0x${'5a'.repeat(32)}`, 22, true, 12, 0.4),
      fundingChequebook(4_000_000_000_000_000n, 4_500_000_000_000_000n),
    ),
    fundingNode(
      `${MOCK_STAGE_ID}:360p`,
      'mock-pool-360p',
      'rung',
      '0x2222222222222222222222222222222222222222',
      null,
      null,
      fundingBatch(`0x${'36'.repeat(32)}`, 20, false, 10, 0.7),
      fundingChequebook(31_234_567_890_123_456n, 32_500_000_000_000_000n),
    ),
    {
      ...fundingNode(
        `${MOCK_STAGE_ID}:720p`,
        'mock-pool-720p',
        'rung',
        '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09',
        '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
        null,
        fundingBatch(`0x${'72'.repeat(32)}`, 20, false, 0, 0.95),
        fundingChequebook(2n * XBZZ, 25_000_000_000_000_000n),
      ),
      xdaiWei: 0n,
    },
    fundingNode(
      `${MOCK_STAGE_ID}:1080p`,
      'mock-pool-1080p',
      'rung',
      '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
      '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
      null,
      { ...fundingBatch(`0x${'10'.repeat(32)}`, 20, false, 20, 0.3), readError: 'The node did not answer in time.' },
      fundingChequebook(null, null, 'The node did not answer in time.'),
    ),
    fundingNode(`${MOCK_STAGE_ID}:gateway`, 'mock-gateway', 'gateway', null, null, 'The node did not answer.'),
    fundingNode(
      `${MOCK_STAGE_ID}:light-gateway`,
      'mock-light-gateway',
      'gateway',
      '0x3333333333333333333333333333333333333333',
      '0x3333333333333333333333333333333333333333',
      null,
      null,
      fundingChequebook(15_000_000_000_000_000n, 16_000_000_000_000_000n),
    ),
  ].map((node) => [node.nodeId, node]),
);

/*
 * The archive stamps (`docs/architecture/web2-admin.md`, "Archiving a recording"), each held by a node of the funding
 * mock, which pays for its top-ups. MOCK_ARCHIVE_STAMPS decides them, with the values `MOCK_ARCHIVE_STAMPS_SEEDS` of
 * `src/components/archive/archiveSeams.ts` lists:
 *
 * - `some`, the default: on the catalogue node, "Talks", depth 22 with 200 days and room, "Spring", depth 20 with 120
 *   days and nearly full, and "Autumn", depth 21 with 20 days, under the warning.
 * - `none`: no archive stamp.
 * - `buying`: `some`, and a purchase of a depth 19 stamp, "Summer", waiting to be usable, which turns into a stamp 10
 *   seconds after the mock starts.
 * - `left`: `some`, and "Old node", depth 21 with 50 days, left on the mock stage's uploader, a node that is the
 *   catalogue node no longer: topped up only.
 * - `unoffered`: `some`, and the purchase route answers as a manager that offers no purchases does.
 *
 * A purchase made here is checked as the API checks it, the cost it names priced again; it is being bought for 5
 * seconds, waits to be usable for 10 more, then is a stamp on the catalogue node, its cost taken from that node's
 * wallet. MOCK_FUNDING=refuse fails every one.
 */
const ARCHIVE_STAMPS_SEED = process.env.MOCK_ARCHIVE_STAMPS ?? 'some';
const ARCHIVE_PURCHASE_BOUGHT_AFTER_MS = 5_000;
const ARCHIVE_PURCHASE_USABLE_AFTER_MS = 15_000;
const ARCHIVE_TTL_WARNING_DAYS = 30;
const ARCHIVE_BUY_DEFAULT_DAYS = 30;
const ARCHIVE_BUY_MIN_DAYS = 2;
const ARCHIVE_CATALOGUE_NODE_ID = 'catalogue:bee-uploader';
/** `ARCHIVE_PURCHASES_NOT_OFFERED` of the admin's common package, as the API answers it. */
const ARCHIVE_PURCHASES_NOT_OFFERED =
  'The manager does not offer stamp purchases. A manager older than this page does not buy archive stamps.';

/** What an immutable batch of each depth holds, in bytes: the table of `packages/contracts/src/archiveCapacity.ts`. */
const ARCHIVE_EFFECTIVE_BYTES = {
  17: 44_700,
  18: 6_660_000,
  19: 112_060_000,
  20: 687_620_000,
  21: 2_600_000_000,
  22: 7_730_000_000,
  23: 19_940_000_000,
  24: 47_060_000_000,
  25: 105_510_000_000,
  26: 227_980_000_000,
  27: 476_680_000_000,
  28: 993_650_000_000,
  29: 2_040_000_000_000,
  30: 4_170_000_000_000,
  31: 8_450_000_000_000,
  32: 17_070_000_000_000,
  33: 34_360_000_000_000,
  34: 69_040_000_000_000,
  35: 138_540_000_000_000,
  36: 277_720_000_000_000,
  37: 556_350_000_000_000,
  38: 1_110_000_000_000_000,
  39: 2_230_000_000_000_000,
  40: 4_460_000_000_000_000,
  41: 8_930_000_000_000_000,
};

function archiveEffectiveChunks(depth) {
  return Math.floor((ARCHIVE_EFFECTIVE_BYTES[depth] ?? 0) / 4096);
}

/**
 * An archive stamp as the mock holds it: a batch, with the node that holds it, its label, whether it is written, and
 * what is on it.
 */
function archiveStamp(nodeId, batchId, depth, daysLeft, fillRatio, label, writable, qualities, stampedShare) {
  return {
    ...fundingBatch(batchId, depth, true, daysLeft, fillRatio),
    nodeId,
    label,
    writable,
    designatedAt: new Date(Date.now() - 20 * DAY_MS).toISOString(),
    chunksStamped: Math.floor(archiveEffectiveChunks(depth) * stampedShare),
    qualitiesArchived: qualities,
  };
}

/** The archive stamps, in the order they were designated. */
const archiveStamps =
  ARCHIVE_STAMPS_SEED === 'none'
    ? []
    : [
        archiveStamp(ARCHIVE_CATALOGUE_NODE_ID, `0x${'a1'.repeat(32)}`, 22, 200, 0.1, 'Talks', true, 3, 0.3),
        archiveStamp(ARCHIVE_CATALOGUE_NODE_ID, `0x${'a2'.repeat(32)}`, 20, 120, 0.97, 'Spring', true, 2, 0.96),
        archiveStamp(ARCHIVE_CATALOGUE_NODE_ID, `0x${'a3'.repeat(32)}`, 21, 20, 0.4, 'Autumn', true, 1, 0.35),
        ...(ARCHIVE_STAMPS_SEED === 'left'
          ? [
              archiveStamp(
                `${MOCK_STAGE_ID}:bee-uploader`,
                `0x${'a5'.repeat(32)}`,
                21,
                50,
                0.4,
                'Old node',
                false,
                2,
                0.35,
              ),
            ]
          : []),
      ];

/** id -> a purchase of an archive stamp, as the admin journals it. */
const archivePurchases = new Map();

/** The amount each chunk gets for `days` at today's price: the price of every block of the days, rounded up. */
function archiveAmountPerChunk(days) {
  // A batch of depth 0 costs exactly its amount per chunk.
  return topUpCost(days, 0);
}

if (ARCHIVE_STAMPS_SEED === 'buying') {
  const amount = archiveAmountPerChunk(ARCHIVE_BUY_DEFAULT_DAYS);
  const id = randomUUID();
  archivePurchases.set(id, {
    id,
    depth: 19,
    days: ARCHIVE_BUY_DEFAULT_DAYS,
    amountPerChunkPlur: amount.toString(),
    costPlur: (amount << 19n).toString(),
    label: 'Summer',
    batchId: `0x${'a4'.repeat(32)}`,
    error: null,
    startedBy: 'admin',
    startedAt: new Date().toISOString(),
    // Seeded already bought and paid for, so it waits to be usable from the start, for 10 seconds.
    requestedAt: Date.now() - ARCHIVE_PURCHASE_BOUGHT_AFTER_MS,
    boughtAt: Date.now(),
    failed: false,
    settled: false,
  });
}

/** The batch of `node` named `batchId`: its own, or an archive stamp it holds, or null. */
function nodeBatch(node, batchId) {
  if (!node) return null;
  if (node.batch && node.batch.batchId === batchId) return node.batch;
  return archiveStamps.find((stamp) => stamp.nodeId === node.nodeId && stamp.batchId === batchId) ?? null;
}

/**
 * Where a purchase stands now, its stamp added on the catalogue node once it is usable, and its cost taken from the
 * node's wallet once it is bought.
 */
function archivePurchaseState(purchase, now = Date.now()) {
  if (purchase.failed) return 'failed';
  if (now - purchase.requestedAt < ARCHIVE_PURCHASE_BOUGHT_AFTER_MS) return 'buying';
  const node = fundingNodes.get(ARCHIVE_CATALOGUE_NODE_ID);
  if (purchase.boughtAt === null) {
    purchase.boughtAt = now;
    node.xbzzPlur -= BigInt(purchase.costPlur);
    node.xdaiWei = node.xdaiWei > STAMP_GAS_WEI ? node.xdaiWei - STAMP_GAS_WEI : 0n;
  }
  if (now - purchase.requestedAt < ARCHIVE_PURCHASE_USABLE_AFTER_MS) return 'waiting_usable';
  if (!purchase.settled) {
    purchase.settled = true;
    archiveStamps.push(
      archiveStamp(node.nodeId, purchase.batchId, purchase.depth, purchase.days, 0, purchase.label, true, 0, 0),
    );
  }
  return 'usable';
}

function archivePurchaseAnswer(purchase) {
  const state = archivePurchaseState(purchase);
  return {
    id: purchase.id,
    depth: purchase.depth,
    days: purchase.days,
    amountPerChunkPlur: purchase.amountPerChunkPlur,
    costPlur: purchase.costPlur,
    label: purchase.label,
    state,
    batchId: state === 'buying' || state === 'failed' ? null : purchase.batchId.slice(2),
    error: purchase.error,
    startedBy: purchase.startedBy,
    startedAt: purchase.startedAt,
  };
}

/** `GET /api/archive/stamps`: the stamps with their room, the purchases still running, and what a purchase needs. */
function archiveStampsAnswer() {
  const catalogue = fundingNodes.get(ARCHIVE_CATALOGUE_NODE_ID);
  const purchases = [...archivePurchases.values()]
    .map(archivePurchaseAnswer)
    .filter((purchase) => purchase.state === 'buying' || purchase.state === 'waiting_usable')
    .reverse();
  return {
    nodeName: catalogue.label,
    stamps: archiveStamps.map((stamp) => {
      const ttlSeconds = ttlOf(stamp);
      const effectiveChunks = archiveEffectiveChunks(stamp.depth);
      return {
        batchId: stamp.batchId.slice(2),
        label: stamp.label,
        nodeId: stamp.nodeId,
        nodeLabel: fundingNodes.get(stamp.nodeId)?.label ?? null,
        depth: stamp.depth,
        immutable: true,
        state: ttlSeconds > 0 ? (stamp.fillRatio >= 1 ? 'full' : 'active') : 'expired',
        ttlSeconds,
        fillRatio: stamp.fillRatio,
        writable: stamp.writable && stamp.nodeId === ARCHIVE_CATALOGUE_NODE_ID && ttlSeconds > 0,
        designatedAt: stamp.designatedAt,
        effectiveChunks,
        chunksStamped: stamp.chunksStamped,
        roomChunks: Math.max(0, effectiveChunks - stamp.chunksStamped),
        qualitiesArchived: stamp.qualitiesArchived,
        expiresSoon: ttlSeconds < ARCHIVE_TTL_WARNING_DAYS * 86_400,
      };
    }),
    purchases,
    buy: {
      postage: FUNDING_POSTAGE,
      walletXbzzPlur: catalogue.xbzzPlur.toString(),
      walletXdaiWei: catalogue.xdaiWei.toString(),
      defaultDays: ARCHIVE_BUY_DEFAULT_DAYS,
      minimumDays: ARCHIVE_BUY_MIN_DAYS,
    },
    buyUnavailable: null,
    ttlWarningDays: ARCHIVE_TTL_WARNING_DAYS,
  };
}

/**
 * Why the mock refuses a purchase, as the API checks one, with the refusal's problem, or null: a depth of the table,
 * whole days of 2 or more, a label of 1 to 64 characters or none, the cost the dialog showed equal to what the depth
 * and the days cost at today's price, and a catalogue node's wallet that holds it and some xDAI for the gas.
 */
function archivePurchaseRefusal(choice) {
  const refused = (message, problem = 'purchase_refused') => ({ problem, message });
  const depth = choice?.depth;
  if (!Number.isInteger(depth) || ARCHIVE_EFFECTIVE_BYTES[depth] === undefined) {
    return refused("An archive stamp's depth is 17 to 41.");
  }
  if (!Number.isSafeInteger(choice.days) || choice.days < ARCHIVE_BUY_MIN_DAYS) {
    return refused(`A new archive stamp lasts ${ARCHIVE_BUY_MIN_DAYS} days or more.`);
  }
  const label = choice.label;
  if (label !== null && (typeof label !== 'string' || label.trim().length < 1 || label.trim().length > 64)) {
    return refused('A label is 1 to 64 characters, or none.');
  }
  const cost = archiveAmountPerChunk(choice.days) << BigInt(depth);
  if (typeof choice.costPlur !== 'string' || choice.costPlur !== cost.toString()) {
    return refused(
      `The price of postage moved, and this stamp now costs ${cost} PLUR. Confirm it again at that cost.`,
      'price_moved',
    );
  }
  const node = fundingNodes.get(ARCHIVE_CATALOGUE_NODE_ID);
  if (cost > node.xbzzPlur) {
    return refused(
      `The catalogue node's wallet is ${cost - node.xbzzPlur} PLUR short of the stamp's cost. Send it xBZZ on the Balance tab.`,
    );
  }
  if (node.xdaiWei === 0n) {
    return refused("The catalogue node's wallet holds no xDAI for the gas. Send it xDAI on the Balance tab.");
  }
  return null;
}

/** bulkId -> the transfers one send asked for. */
const fundingBulks = new Map();

/** bulkId -> the top-ups or dilutions one stamp request asked for. */
const stampBulks = new Map();

/** bulkId -> the deposits and withdrawals one chequebook request asked for. */
const chequebookBulks = new Map();

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

/**
 * A chequebook as the manager answers it: every reading null, and why, for one its node could not be read about, and
 * null for a node that has none.
 */
function chequebookAnswer(chequebook) {
  if (chequebook === null) return null;
  if (chequebook.readError) {
    return { address: null, availablePlur: null, totalPlur: null, readError: chequebook.readError };
  }
  return {
    address: chequebook.address,
    availablePlur: chequebook.availablePlur.toString(),
    totalPlur: chequebook.totalPlur.toString(),
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
    chequebook: chequebookAnswer(node.chequebook),
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
 * every block of the days, rounded up and counted in BigInt, for each of the batch's 2^depth chunks.
 */
function topUpCost(days, depth) {
  const blockSeconds = BigInt(FUNDING_POSTAGE.blockSeconds);
  const blocks = (BigInt(days) * 86_400n + blockSeconds - 1n) / blockSeconds;
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
      const batch = nodeBatch(node, item.batchId);
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
 * its node, read, usable and at the depth the page saw; whole days of 1 or more, at a price of postage no lower than
 * today's; 1 or 2 steps that leave 7 days; every node's xBZZ covering its top-ups and some xDAI for the gas.
 */
function stampRefusal(asked) {
  if (asked.length === 0) return 'Tick a batch first.';
  if (new Set(asked.map((item) => item?.kind)).size !== 1) return 'A stamp request takes one kind of operation.';
  if (new Set(asked.map((item) => item?.batchId)).size !== asked.length) return 'A batch is named twice.';
  const costs = new Map();
  for (const item of asked) {
    const node = fundingNodes.get(item?.nodeId);
    const batch = nodeBatch(node, item?.batchId);
    if (!batch) return `${item?.batchId} is not a batch of ${item?.nodeId}.`;
    if (batch.readError || ttlOf(batch) === 0) return `The batch of ${node.label} cannot take it now.`;
    if (batch.depth !== item.expectedDepth) {
      return `The batch of ${node.label} is at depth ${batch.depth} now, not ${item.expectedDepth}.`;
    }
    if (item.kind === 'topup') {
      if (!Number.isSafeInteger(item.days) || item.days < 1) return 'The days are a whole number, 1 or more.';
      const quoted = item.pricePerChunkPerBlockPlur;
      if (typeof quoted !== 'string' || !/^[1-9]\d{0,77}$/.test(quoted)) {
        return 'A top-up names the price of postage the page quoted it at.';
      }
      if (BigInt(FUNDING_POSTAGE.pricePerChunkPerBlockPlur) > BigInt(quoted)) {
        return 'The price of postage has risen since the page read it. Read the page again.';
      }
      costs.set(node, (costs.get(node) ?? 0n) + topUpCost(item.days, batch.depth));
    } else if (item.kind === 'dilute') {
      if (item.steps !== 1 && item.steps !== 2) return 'A dilution takes 1 or 2 steps.';
      if (batch.writable === false) return `The archive stamp ${batch.label ?? batch.batchId} is topped up only.`;
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

/**
 * What brings a chequebook whose available balance is `available` to `target`, as the common chequebookMove works it
 * out: a deposit of the difference under it, a withdrawal of the difference over it, and null at it. BigInt PLUR.
 */
function chequebookMove(target, available) {
  if (target === available) return null;
  return target > available
    ? { direction: 'deposit', amount: target - available }
    : { direction: 'withdraw', amount: available - target };
}

/**
 * The move a chequebook bulk makes, as the common chequebookMoveNow works it out again when the request comes in: from
 * the available balance the page showed, `shown`, and the one the chequebook holds now, never more than the page
 * showed. A deposit is the target less the larger of the two, a withdrawal the smaller less the target, and null when
 * the page showed none or the chequebook is at the target or past it now. BigInt PLUR.
 */
function chequebookMoveNow(target, shown, now) {
  if (shown < target && now < target) return { direction: 'deposit', amount: target - (shown > now ? shown : now) };
  if (shown > target && now > target) return { direction: 'withdraw', amount: (shown < now ? shown : now) - target };
  return null;
}

/** Whether a chequebook operation holds up a new chequebook bulk, as a stamp operation holds up a new stamp bulk. */
function chequebookHoldsNext(item, now = Date.now()) {
  return stampHoldsNext(item, now);
}

/**
 * Sends each queued chequebook operation in its turn, finds the lost ones, says each sent long enough ago is mined, and
 * confirms each mined long enough ago, its block final: a deposit moves its amount from the node's wallet into its
 * chequebook, a withdrawal from its chequebook into its wallet, and the node pays the gas. One whose wallet or
 * chequebook no longer holds its amount by then, since a stamp bulk may have spent the wallet's xBZZ meanwhile, fails
 * with nothing moved.
 */
function settleChequebookOperations() {
  const now = Date.now();
  for (const items of chequebookBulks.values()) {
    for (const item of items) {
      const sentAt = item.requestedAt + item.index * CHEQUEBOOK_SEND_EVERY_MS;
      if (item.state === 'queued' && now >= sentAt) {
        item.state = 'submitted';
        item.txHash = `0x${hex(32)}`;
      }
      if (item.state === 'unknown' && now - sentAt >= CHEQUEBOOK_FOUND_AFTER_MS) {
        item.state = 'submitted';
        item.watched = false;
      }
      if (item.state !== 'submitted') continue;
      const minedAt = sentAt + CHEQUEBOOK_MINED_AFTER_MS;
      item.mined = now >= minedAt;
      if (now - minedAt < CHEQUEBOOK_FINAL_AFTER_MS) continue;
      item.mined = false;
      const node = fundingNodes.get(item.nodeId);
      const chequebook = node.chequebook;
      const deposit = item.direction === 'deposit';
      if (item.amount > (deposit ? node.xbzzPlur : chequebook.availablePlur)) {
        item.state = 'failed';
        item.error = deposit
          ? "The node's wallet held less xBZZ than the deposit by then, so nothing moved."
          : 'The chequebook held less than the withdrawal by then, so nothing moved.';
        continue;
      }
      item.state = 'confirmed';
      const signed = deposit ? item.amount : -item.amount;
      chequebook.availablePlur += signed;
      chequebook.totalPlur += signed;
      node.xbzzPlur -= signed;
      node.xdaiWei = node.xdaiWei > CHEQUEBOOK_GAS_WEI ? node.xdaiWei - CHEQUEBOOK_GAS_WEI : 0n;
    }
  }
}

/** The latest chequebook bulk with an operation that holds up a new one, as the API names it, or null. */
function openChequebookBulkId() {
  let open = null;
  for (const [bulkId, items] of chequebookBulks) {
    if (items.some((item) => chequebookHoldsNext(item))) open = bulkId;
  }
  return open;
}

/** A chequebook operation as the API answers it, on the request and on every read. */
function chequebookItemAnswer(item) {
  return {
    requestId: item.requestId,
    nodeId: item.nodeId,
    nodeLabel: item.nodeLabel,
    direction: item.direction,
    amountPlur: item.amount.toString(),
    targetPlur: item.target.toString(),
    state: item.state,
    txHash: item.txHash,
    error: item.error,
    mined: item.mined,
    settled: !chequebookHoldsNext(item),
    watched: item.watched,
  };
}

/** PLUR as a chequebook request carries it, as the API takes it: whole, and 30 digits at most. */
const CHEQUEBOOK_PLUR = /^(0|[1-9]\d{0,29})$/;

/**
 * Why the mock refuses a chequebook request, as the API checks one, or null: a target of base units, 30 digits at
 * most, and 1 xBZZ or more; each node once, a stage's own Bee node or a rung with its wallet and chequebook read, never
 * a gateway nor the catalogue node, with the available balance the page showed, never one at the target; its move
 * worked out again from that and the balance the chequebook holds now, and refused when the chequebook is at the
 * target or past it now; a deposit when the wallet holds less xBZZ than it, and either way when the node has no xDAI
 * for the gas.
 */
function chequebookRefusal(body) {
  const target = body?.targetPlur;
  if (typeof target !== 'string' || !CHEQUEBOOK_PLUR.test(target)) {
    return 'The target is a whole number of PLUR, 30 digits at most.';
  }
  if (BigInt(target) < CHEQUEBOOK_TARGET_MIN_PLUR) return 'The target is at least 1 xBZZ.';
  const asked = Array.isArray(body.items) ? body.items : [];
  if (asked.length === 0) return 'Tick a chequebook first.';
  if (new Set(asked.map((item) => item?.nodeId)).size !== asked.length) return 'A node is named twice.';
  for (const item of asked) {
    const node = fundingNodes.get(item?.nodeId);
    if (!node) return `${item?.nodeId} is not a node the manager reports.`;
    if (node.role === 'gateway') {
      return "This manager moves only the chequebook of the catalogue node, a stage's Bee node or a rung.";
    }
    const chequebook = node.chequebook;
    if (!chequebook || chequebook.readError || node.walletAddress === null) {
      return `The chequebook of ${node.label} cannot be moved now.`;
    }
    if (typeof item.availablePlur !== 'string' || !CHEQUEBOOK_PLUR.test(item.availablePlur)) {
      return 'Each chequebook names the available balance the page showed.';
    }
    const shown = BigInt(item.availablePlur);
    if (chequebookMove(BigInt(target), shown) === null) {
      return `The chequebook of ${node.label} is at the target already.`;
    }
    const move = chequebookMoveNow(BigInt(target), shown, chequebook.availablePlur);
    if (move === null) return `The chequebook of ${node.label} is at the target or past it now. Read the page again.`;
    if (move.direction === 'deposit' && move.amount > node.xbzzPlur) {
      return `${node.label} holds less xBZZ than its deposit.`;
    }
    if (node.xdaiWei === 0n) return `${node.label} holds no xDAI to pay the gas.`;
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
      openChequebookBulkId: null,
    };
  }
  settleFundingTransfers();
  settleStampOperations();
  settleChequebookOperations();
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
    openChequebookBulkId: openChequebookBulkId(),
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

/**
 * username@address -> consecutive failures, for the lockout the real API keeps on the account at that address. The
 * mock leaves out the address's own count and the account ceiling.
 */
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

/** The API's default STREAM_RESTART_WINDOW_MINUTES: how long an ended stream can go live again on its key. */
const RESTART_WINDOW_MS = 30 * 60 * 1000;

function publicStream(row) {
  const { thumbnail, thumbnailMime, editsNotOnFeed, ...rest } = row;
  // Absent on a stream with nothing copied, as the API answers it.
  const archive = streamArchiveSummaryOf(row);
  return {
    ...rest,
    hasThumbnail: thumbnail !== null && thumbnailMime !== null,
    hasUnpublishedEdits: editsNotOnFeed && ON_FEED_STATUSES.includes(row.status),
    restartUntil: restartUntil(row),
    ...(archive ? { archive } : {}),
  };
}

/**
 * The end of the restart window, as the API's presenter works it out: only
 * while the stream is `vod` and not finalized, and null otherwise.
 */
function restartUntil(row) {
  if (row.status !== 'vod' || row.finishedAt !== null || row.endedAt === null) return null;
  return new Date(Date.parse(row.endedAt) + RESTART_WINDOW_MS).toISOString();
}

/**
 * What Finalize and the window's sweep both do, as the API's one conditional
 * UPDATE does: a new key, and the stream finalized. The old key is refused at
 * the next connect.
 */
function finish(row, at) {
  row.publishKey = hex(16);
  row.publishKeyRotatedAt = at;
  row.finishedAt = at;
  row.updatedAt = at;
}

/**
 * The API's sweep: a recording whose restart window has run out is finalized,
 * so an old encoder profile cannot bring it back. A `vod` with no end counts
 * as ended long ago. The API runs it at boot and every minute after; the mock
 * runs it at start and before it answers about streams, which shows the same.
 */
function finishEnded(now = Date.now()) {
  for (const row of streams.values()) {
    if (row.status !== 'vod' || row.finishedAt !== null) continue;
    const endedAt = row.endedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(row.endedAt);
    if (endedAt + RESTART_WINDOW_MS <= now) finish(row, new Date(now).toISOString());
  }
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
    // When the key changed for good, by Finalize or once the restart window
    // ran out. Nothing here goes live again, so nothing clears it.
    finishedAt: null,
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

/** A stream on the feed, as a publish puts it there, with what the uploader would have reported. */
function seedStream(input, fields) {
  const row = newStream({ tags: ['mock'], mediaType: 'video', ...input });
  feedIndex += 1;
  feedEntries += 1;
  Object.assign(row, { publishedFeedIndex: feedIndex, stageId: stages[0]?.stageId ?? null, ...fields });
  streams.set(row.id, row);
}

// One stream in each state the stream page tells apart once a stream has gone
// live, since nothing here can broadcast. Their times count back from the start.
const startedAt = Date.now();
const minutesBefore = (minutes) => new Date(startedAt - minutes * 60_000).toISOString();
const DAYS_3 = 3 * 24 * 60;

seedStream(
  {
    title: 'Live now',
    description: 'Seeded live. Nothing here ends it, so Finalize stays disabled on it, and the mock refuses it.',
    scheduledStartTime: minutesBefore(15),
  },
  {
    status: 'live',
    publishedAt: minutesBefore(20),
    liveSince: minutesBefore(12),
    createdAt: minutesBefore(30),
    updatedAt: minutesBefore(12),
  },
);
seedStream(
  {
    title: 'Ended a few minutes ago',
    description:
      'Seeded as ended five minutes before the mock started: it can go live again until its window runs out.',
    scheduledStartTime: minutesBefore(65),
  },
  {
    status: 'vod',
    publishedAt: minutesBefore(70),
    liveSince: minutesBefore(65),
    endedAt: minutesBefore(5),
    durationSeconds: 3600,
    manifestIndex: 360,
    createdAt: minutesBefore(80),
    updatedAt: minutesBefore(5),
  },
);
seedStream(
  {
    title: 'Ended days ago',
    description: 'Seeded as ended three days before the mock started: its window ran out, so its key has changed.',
    scheduledStartTime: minutesBefore(DAYS_3 + 65),
  },
  {
    status: 'vod',
    publishedAt: minutesBefore(DAYS_3 + 70),
    liveSince: minutesBefore(DAYS_3 + 65),
    endedAt: minutesBefore(DAYS_3),
    durationSeconds: 3600,
    manifestIndex: 360,
    createdAt: minutesBefore(DAYS_3 + 80),
    updatedAt: minutesBefore(DAYS_3),
  },
);

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

// The API's boot run: every recording whose window ran out before the start is
// finalized before anything is answered.
finishEnded(startedAt);

function stageUnavailable(res, stageId) {
  return send(res, 409, {
    error: 'stage_unavailable',
    stageId,
    reason: 'unknown',
    message: 'The admin knows no stage with that id. Pick one of the stages listed.',
  });
}

// --- exporting a recording ---------------------------------------------------

/** How long the mock export reads, then joins: long enough to watch the widget move, short enough to wait for. */
const EXPORT_READ_MS = 45_000;
const EXPORT_JOIN_MS = 5_000;
/** Segments a paused-as-unreadable export says it could not read. */
const EXPORT_MISSING = 3;
/** The qualities offered, with the bitrate each is estimated at, in bits a second. */
const EXPORT_QUALITIES = [
  { rendition: '1080p', width: 1920, height: 1080, bitrate: 4_500_000 },
  { rendition: '720p', width: 1280, height: 720, bitrate: 2_800_000 },
  { rendition: '480p', width: 854, height: 480, bitrate: 1_400_000 },
  { rendition: '360p', width: 640, height: 360, bitrate: 800_000 },
];
const EXPORT_OTHER_USER = { id: randomUUID(), username: 'another-operator' };
const MOCK_EXPORT = process.env.MOCK_EXPORT ?? 'running';

/** The one export on the server, or null, as the API holds it. */
let mockExport = null;

function exportSlug(title) {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'stream';
}

function newExport(row, rendition, startedBy, extra = {}) {
  const quality = EXPORT_QUALITIES.find((q) => q.rendition === rendition) ?? EXPORT_QUALITIES[0];
  const seconds = row.durationSeconds ?? 3600;
  return {
    id: randomUUID(),
    streamId: row.id,
    rendition: quality.rendition,
    quality: quality.rendition,
    state: 'reading',
    pauseReason: null,
    pauseMessage: null,
    pausedAt: null,
    segmentsTotal: Math.ceil(seconds / 2),
    estimatedBytes: Math.round((quality.bitrate * seconds) / 8),
    durationSeconds: seconds,
    readMs: 0,
    since: Date.now(),
    failAt: null,
    fileName: null,
    sizeBytes: null,
    partial: false,
    finishedAt: null,
    startedBy: startedBy.username,
    startedByUserId: startedBy.id,
    startedAt: new Date().toISOString(),
    dismissedBy: new Set(),
    ...extra,
  };
}

function readFraction(e, now = Date.now()) {
  return Math.min(1, (e.readMs + (e.state === 'reading' ? now - e.since : 0)) / EXPORT_READ_MS);
}

function pauseExport(e, reason, message, now = Date.now()) {
  e.readMs = readFraction(e, now) * EXPORT_READ_MS;
  Object.assign(e, {
    state: 'paused',
    pauseReason: reason,
    pauseMessage: message,
    pausedAt: new Date(now).toISOString(),
  });
}

function finishExport(e, now = Date.now()) {
  const row = streams.get(e.streamId);
  const day = (row?.liveSince ?? row?.scheduledStartTime ?? new Date(now).toISOString()).slice(0, 10);
  Object.assign(e, {
    state: 'done',
    fileName: `${exportSlug(row?.title ?? 'stream')}-${day}-${e.quality}${e.partial ? '-partial' : ''}.mp4`,
    sizeBytes: Math.round(e.estimatedBytes * (e.partial ? readFraction(e, now) : 1)),
    finishedAt: new Date(now).toISOString(),
  });
}

/** Moves the export on by the clock: reading, then joining, then done; `failAt` pauses it there as unreadable. */
function settleExport(now = Date.now()) {
  const e = mockExport;
  if (!e) return;
  if (e.state === 'reading') {
    const fraction = readFraction(e, now);
    if (e.failAt !== null && fraction >= e.failAt) {
      pauseExport(
        e,
        'unreadable',
        `${EXPORT_MISSING} of ${e.segmentsTotal} segments could not be read from Swarm.`,
        now,
      );
      return;
    }
    if (fraction >= 1) Object.assign(e, { readMs: EXPORT_READ_MS, state: 'joining', since: now });
  }
  if (e.state === 'joining' && now - e.since >= EXPORT_JOIN_MS) finishExport(e, now);
}

function exportActions(e, dismissed) {
  const save = Math.floor(readFraction(e) * e.segmentsTotal) > 0 ? ['save'] : [];
  switch (e.state) {
    case 'reading':
      return ['pause', 'cancel'];
    case 'joining':
      return ['cancel'];
    case 'waiting':
      return [...save, 'cancel'];
    case 'paused':
      if (e.pauseReason === 'live') return [...save, 'wait', 'cancel'];
      if (e.pauseReason === 'disk') return ['resume', 'cancel'];
      return ['resume', ...save, 'cancel'];
    default:
      return dismissed ? ['clear'] : ['dismiss', 'clear'];
  }
}

function exportSummary(e, user) {
  const row = e ? streams.get(e.streamId) : null;
  if (!e || !row) return null;
  const fraction = readFraction(e);
  const missing = e.pauseReason === 'unreadable' ? EXPORT_MISSING : 0;
  const dismissed = e.dismissedBy.has(user.id);
  return {
    id: e.id,
    streamId: e.streamId,
    streamTitle: row.title,
    rendition: e.rendition,
    quality: e.quality,
    state: e.state,
    pauseReason: e.pauseReason,
    pauseMessage: e.pauseMessage,
    pausedAt: e.pausedAt,
    segmentsTotal: e.segmentsTotal,
    segmentsRead: Math.max(0, Math.floor(fraction * e.segmentsTotal) - missing),
    segmentsMissing: missing,
    bytesRead: Math.round(fraction * e.estimatedBytes),
    estimatedBytes: e.estimatedBytes,
    durationSeconds: e.durationSeconds,
    fileName: e.fileName,
    sizeBytes: e.sizeBytes,
    partial: e.partial,
    startedBy: e.startedBy,
    startedByYou: user.id === e.startedByUserId,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
    dismissed,
    actions: exportActions(e, dismissed),
  };
}

function exportRefusal(row) {
  if (!((row.status === 'vod' || row.status === 'draft') && row.manifestIndex !== null)) {
    return {
      problem: 'not_recording',
      message: `Only a finished recording can be exported, and this stream is ${row.status}.`,
    };
  }
  if (mockExport && mockExport.state !== 'done') {
    const title = streams.get(mockExport.streamId)?.title ?? 'a stream';
    return {
      problem: 'busy',
      message: `The export of "${title}" (${mockExport.quality}) is not finished, started by ${mockExport.startedBy}. One export runs at a time.`,
    };
  }
  if (archiveJobHoldsPlace(mockArchive)) {
    const title = streams.get(mockArchive.streamId)?.title ?? 'a stream';
    return {
      problem: 'busy',
      message: `The archive of "${title}" is under way, started by ${mockArchive.startedBy}. One job runs at a time, an export or an archive.`,
    };
  }
  return null;
}

function exportOptions(row, user) {
  const seconds = row.durationSeconds ?? null;
  return {
    streamId: row.id,
    title: row.title,
    date: (row.liveSince ?? row.scheduledStartTime ?? '').slice(0, 10) || null,
    durationSeconds: seconds,
    qualities: EXPORT_QUALITIES.map((q) => ({
      rendition: q.rendition,
      label: q.rendition,
      width: q.width,
      height: q.height,
      durationSeconds: seconds,
      estimatedBytes: seconds ? Math.round((q.bitrate * seconds) / 8) : null,
      unavailable: null,
    })),
    refusal: exportRefusal(row),
    current: exportSummary(mockExport, user),
  };
}

{
  const recording = [...streams.values()].find((r) => r.status === 'vod' && r.manifestIndex !== null);
  const seeded = [...users.values()][0] ?? null;
  if (recording && MOCK_EXPORT === 'paused' && seeded) {
    mockExport = newExport(recording, '1080p', seeded, { failAt: 0.05 });
  } else if (recording && MOCK_EXPORT === 'done') {
    mockExport = newExport(recording, '1080p', EXPORT_OTHER_USER);
    finishExport(mockExport);
  } else if (recording && MOCK_EXPORT !== 'off') {
    mockExport = newExport(recording, '720p', EXPORT_OTHER_USER);
  }
}

// --- archiving a recording ---------------------------------------------------

const MOCK_ARCHIVE = process.env.MOCK_ARCHIVE ?? 'off';
/** How long the mock archive measures, copies and verifies, and how long a new stamp takes to buy, then to be usable. */
const ARCHIVE_JOB_MEASURE_MS = 6_000;
const ARCHIVE_JOB_COPY_MS = 60_000;
const ARCHIVE_JOB_VERIFY_MS = 8_000;
const ARCHIVE_JOB_BUY_MS = 6_000;
const ARCHIVE_JOB_USABLE_MS = 6_000;
/** Parity's share on top of a recording's bytes, at the erasure level its segments are uploaded with. */
const ARCHIVE_JOB_PARITY = 1.1;
/** What copying one chunk costs the catalogue node's chequebook, low and high, in PLUR. */
const ARCHIVE_JOB_PLUR_PER_CHUNK = [7_700_000_000n, 11_500_000_000n];
/** The room a stamp is sized with beside the chunks it is sized for: 5%. */
const ARCHIVE_JOB_MARGIN = 1.05;
/** What the catalogue node's chequebook can pay, and what it holds under the floor, in PLUR. */
const ARCHIVE_JOB_CHEQUEBOOK_PLUR = '20000000000000000';
const ARCHIVE_JOB_THIN_CHEQUEBOOK_PLUR = '4000000000000000';
/** What an immutable batch of each depth holds, in bytes: the capacity table of `packages/contracts`. */
const ARCHIVE_JOB_CAPACITY_BYTES = {
  17: 44_700,
  18: 6_660_000,
  19: 112_060_000,
  20: 687_620_000,
  21: 2_600_000_000,
  22: 7_730_000_000,
  23: 19_940_000_000,
  24: 47_060_000_000,
  25: 105_510_000_000,
  26: 227_980_000_000,
  27: 476_680_000_000,
  28: 993_650_000_000,
  29: 2_040_000_000_000,
  30: 4_170_000_000_000,
  31: 8_450_000_000_000,
  32: 17_070_000_000_000,
  33: 34_360_000_000_000,
  34: 69_040_000_000_000,
  35: 138_540_000_000_000,
  36: 277_720_000_000_000,
  37: 556_350_000_000_000,
  38: 1_110_000_000_000_000,
  39: 2_230_000_000_000_000,
  40: 4_460_000_000_000_000,
  41: 8_930_000_000_000_000,
};
/** The best a quality's copy can be, then down to none, as the stream list ranks them. */
const ARCHIVE_JOB_STATE_RANK = { complete: 6, reduced: 5, unlisted: 4, outdated: 3, expired: 2, partial: 1, none: 0 };
/** The states in which a quality plays from its archive stamp, as the contract's `ARCHIVED_STATES`. */
const ARCHIVE_JOB_ARCHIVED = new Set(['complete', 'reduced', 'unlisted']);

function archiveJobChunksAt(depth) {
  const bytes = ARCHIVE_JOB_CAPACITY_BYTES[depth];
  return bytes === undefined ? 0 : Math.floor(bytes / 4096);
}

function archiveJobStamp(label, depth, chunksStamped, daysLeft) {
  return {
    batchId: hex(32),
    label,
    depth,
    effectiveChunks: archiveJobChunksAt(depth),
    chunksStamped,
    expiresAt: Date.now() + daysLeft * DAY_MS,
  };
}

/**
 * The catalogue node's archive stamps as the archive panel offers them: one with room, one nearly full that expires
 * within the 30-day warning, and one expired, which holds a recording's only copy.
 */
const archiveJobStamps = [
  archiveJobStamp('Archive 2026', 22, 640_000, 200),
  archiveJobStamp('Short talks', 20, 158_000, 20),
  archiveJobStamp('Old archive', 20, 90_000, -3),
];

/** Each stream's copies, by quality, as `stream_archives` holds them. */
const archiveCopies = new Map();
/** The streams whose catalogue entry lists their archived qualities only. */
const archivedOnlyStreams = new Set();
/** The stream whose other qualities' stage batch has expired, which its archive card hints at. */
let archiveHintStreamId = null;
/** The one archive on the server, or null, as the API holds it. */
let mockArchive = null;

/** A stream's archive as the stream list and the stream's own answer carry it, or undefined with nothing copied. */
function streamArchiveSummaryOf(row) {
  const copies = archiveCopies.get(row.id);
  if (!copies || copies.size === 0) return undefined;
  let state = 'none';
  const archived = [];
  for (const copy of copies.values()) {
    if (ARCHIVE_JOB_STATE_RANK[copy.state] > ARCHIVE_JOB_STATE_RANK[state]) state = copy.state;
    if (ARCHIVE_JOB_ARCHIVED.has(copy.state)) archived.push(copy.rendition);
  }
  return { state, archived, archivedOnly: archivedOnlyStreams.has(row.id) };
}

/** What copying a quality of a recording this long is expected to need, parity included. */
function archiveJobEstimate(quality, seconds) {
  const bytes = Math.round(((quality.bitrate * seconds) / 8) * ARCHIVE_JOB_PARITY);
  const chunks = Math.ceil(bytes / 4096);
  return {
    bytes,
    chunks,
    segments: Math.ceil(seconds / 2),
    bzzLowPlur: (BigInt(chunks) * ARCHIVE_JOB_PLUR_PER_CHUNK[0]).toString(),
    bzzHighPlur: (BigInt(chunks) * ARCHIVE_JOB_PLUR_PER_CHUNK[1]).toString(),
    // The pace of the mock's own clock, so the estimate matches what a start shows.
    seconds: Math.round(ARCHIVE_JOB_MEASURE_MS / 1000 + ARCHIVE_JOB_COPY_MS / 1000 + ARCHIVE_JOB_VERIFY_MS / 1000),
  };
}

function archiveJobQuality(rendition) {
  return EXPORT_QUALITIES.find((q) => q.rendition === rendition) ?? EXPORT_QUALITIES[0];
}

/** One quality's copy, whole or partial, on a stamp. */
function archiveCopy(row, rendition, state, stamp, completedBy, extra = {}) {
  const estimate = archiveJobEstimate(archiveJobQuality(rendition), row.durationSeconds ?? 3600);
  const share = state === 'partial' ? 0.4 : 1;
  return {
    rendition,
    state,
    batchId: stamp.batchId,
    batchLabel: stamp.label,
    chunks: Math.round(estimate.chunks * share),
    bytes: Math.round(estimate.bytes * share),
    parityMissing: 0,
    completedAt: state === 'partial' ? null : (row.endedAt ?? row.updatedAt),
    completedBy: state === 'partial' ? null : completedBy,
    ...extra,
  };
}

function setArchiveCopies(row, copies) {
  archiveCopies.set(row.id, new Map(copies.map((copy) => [copy.rendition, copy])));
}

function archiveJobStampAnswer(stamp, now = Date.now()) {
  const expired = stamp.expiresAt <= now;
  const ttlSeconds = expired ? 0 : Math.round((stamp.expiresAt - now) / 1000);
  let held = 0;
  for (const copies of archiveCopies.values()) {
    for (const copy of copies.values()) if (copy.batchId === stamp.batchId) held += 1;
  }
  return {
    batchId: stamp.batchId,
    label: stamp.label,
    nodeId: null,
    nodeLabel: null,
    depth: stamp.depth,
    immutable: true,
    state: expired ? 'expired' : 'active',
    ttlSeconds,
    fillRatio: Number(Math.min(1, stamp.chunksStamped / stamp.effectiveChunks).toFixed(2)),
    writable: !expired,
    designatedAt: '2026-11-01T10:00:00.000Z',
    effectiveChunks: stamp.effectiveChunks,
    chunksStamped: stamp.chunksStamped,
    roomChunks: Math.max(0, stamp.effectiveChunks - stamp.chunksStamped),
    qualitiesArchived: held,
    expiresSoon: !expired && ttlSeconds < 30 * 86_400,
  };
}

/** What a new stamp is priced with: the funding mock's price of postage and a catalogue node wallet of 10 xBZZ. */
function archiveJobBuyTerms() {
  return {
    postage: FUNDING_POSTAGE,
    walletXbzzPlur: (10n * XBZZ).toString(),
    walletXdaiWei: '2000000000000000000',
    defaultDays: 30,
    minimumDays: 2,
  };
}

/** The price of every block of `days`, the blocks rounded up, for one chunk, in PLUR. */
function archiveJobAmountPerChunk(days) {
  const blockSeconds = BigInt(FUNDING_POSTAGE.blockSeconds);
  const blocks = (BigInt(days) * 86_400n + blockSeconds - 1n) / blockSeconds;
  return blocks * BigInt(FUNDING_POSTAGE.pricePerChunkPerBlockPlur);
}

function archiveJobCost(depth, days) {
  return (archiveJobAmountPerChunk(days) << BigInt(depth)).toString();
}

function archiveJobChunks(job) {
  return job.items.reduce((sum, item) => sum + item.chunks, 0);
}

function newArchiveJob(row, renditions, target, startedBy, extra = {}) {
  const seconds = row.durationSeconds ?? 3600;
  return {
    id: randomUUID(),
    streamId: row.id,
    items: renditions.map((rendition) => {
      const quality = archiveJobQuality(rendition);
      return {
        rendition: quality.rendition,
        ...archiveJobEstimate(quality, seconds),
        rebuilt: quality.rendition === '1080p' ? 14 : 0,
        parityMissing: 0,
      };
    }),
    target,
    state: 'measuring',
    measured: false,
    since: Date.now(),
    copyMs: 0,
    resumeTo: null,
    pauseReason: null,
    pauseMessage: null,
    pausedAt: null,
    chequebookPlur: ARCHIVE_JOB_CHEQUEBOOK_PLUR,
    startedBy: startedBy.username,
    startedByUserId: startedBy.id,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    dismissedBy: new Set(),
    ...extra,
  };
}

/** Whether the archive holds the place a job has, as the API's `archiveHoldsPlace` says. */
function archiveJobHoldsPlace(job) {
  if (!job || job.state === 'done' || job.state === 'awaiting_purchase') return false;
  if (job.state === 'paused') return job.pauseReason !== 'user';
  return true;
}

function archiveJobCopied(job, now = Date.now()) {
  return Math.min(1, (job.copyMs + (job.state === 'copying' ? now - job.since : 0)) / ARCHIVE_JOB_COPY_MS);
}

function pauseArchiveJob(job, reason, message, now = Date.now()) {
  if (job.state === 'copying') job.copyMs += now - job.since;
  job.resumeTo = job.state;
  Object.assign(job, {
    state: 'paused',
    pauseReason: reason,
    pauseMessage: message,
    pausedAt: new Date(now).toISOString(),
    since: now,
  });
}

/** Each quality's copy goes on the stream once the archive is done: complete, or reduced with parity left out. */
function finishArchiveJob(job, now = Date.now()) {
  job.state = 'done';
  job.finishedAt = new Date(now).toISOString();
  const row = streams.get(job.streamId);
  if (!row) return;
  const copies = archiveCopies.get(row.id) ?? new Map();
  const stamp = archiveJobStamps.find((candidate) => candidate.batchId === job.target.batchId);
  for (const item of job.items) {
    copies.set(item.rendition, {
      rendition: item.rendition,
      state: item.parityMissing > 0 ? 'reduced' : 'complete',
      batchId: job.target.batchId ?? null,
      batchLabel: job.target.label ?? null,
      chunks: item.chunks,
      bytes: item.bytes,
      parityMissing: item.parityMissing,
      completedAt: job.finishedAt,
      completedBy: job.startedBy,
    });
    if (stamp) stamp.chunksStamped += item.chunks;
  }
  archiveCopies.set(row.id, copies);
}

/** Moves the archive on by the clock: measuring, a purchase, copying, verifying, then done. */
function settleArchiveJob(now = Date.now()) {
  const job = mockArchive;
  if (!job) return;
  for (let step = 0; step < 6; step += 1) {
    const elapsed = now - job.since;
    if (job.state === 'measuring' && elapsed >= ARCHIVE_JOB_MEASURE_MS) {
      job.measured = true;
      job.state = job.target.kind === 'purchase' && job.target.purchase === null ? 'awaiting_purchase' : 'copying';
      job.since = now;
    } else if (job.state === 'buying' && elapsed >= ARCHIVE_JOB_BUY_MS) {
      Object.assign(job.target.purchase, { state: 'waiting_usable', batchId: hex(32) });
      Object.assign(job, { state: 'waiting_usable', since: now });
    } else if (job.state === 'waiting_usable' && elapsed >= ARCHIVE_JOB_USABLE_MS) {
      const purchase = job.target.purchase;
      purchase.state = 'usable';
      archiveJobStamps.push({
        batchId: purchase.batchId,
        label: purchase.label,
        depth: purchase.depth,
        effectiveChunks: archiveJobChunksAt(purchase.depth),
        chunksStamped: 0,
        expiresAt: now + purchase.days * DAY_MS,
      });
      job.target = { kind: 'stamp', batchId: purchase.batchId, label: purchase.label };
      Object.assign(job, { state: 'copying', since: now });
    } else if (job.state === 'copying' && archiveJobCopied(job, now) >= 1) {
      Object.assign(job, { copyMs: ARCHIVE_JOB_COPY_MS, state: 'verifying', since: now });
    } else if (job.state === 'verifying' && elapsed >= ARCHIVE_JOB_VERIFY_MS) {
      finishArchiveJob(job, now);
    } else {
      return;
    }
  }
}

/** Each chosen quality, copied one after another in the order chosen. */
function archiveJobItems(job, now = Date.now()) {
  const count = job.items.length;
  const copied = archiveJobCopied(job, now);
  const verified = job.state === 'verifying' ? Math.min(1, (now - job.since) / ARCHIVE_JOB_VERIFY_MS) : 0;
  return job.items.map((item, index) => {
    const share = Math.max(0, Math.min(1, copied * count - index));
    let state = 'waiting';
    if (job.state === 'done') state = 'done';
    else if (!job.measured) state = job.state === 'measuring' ? 'measuring' : 'waiting';
    else if (job.state === 'verifying') state = index === count - 1 ? 'verifying' : 'done';
    else if (share >= 1) state = 'done';
    else if (share > 0) state = 'copying';
    const whole = state === 'done' || state === 'verifying';
    const chunksCopied = whole ? item.chunks : Math.round(share * item.chunks);
    let chunksSynced = Math.round(chunksCopied * 0.9);
    if (state === 'done') chunksSynced = item.chunks;
    if (state === 'verifying') chunksSynced = Math.round(item.chunks * (0.9 + 0.1 * verified));
    return {
      rendition: item.rendition,
      label: item.rendition,
      state,
      result: state === 'done' ? (item.parityMissing > 0 ? 'reduced' : 'complete') : null,
      segmentsTotal: job.measured ? item.segments : null,
      segmentsDone: whole ? item.segments : Math.round(share * item.segments),
      chunksTotal: job.measured ? item.chunks : null,
      chunksCopied,
      chunksRebuilt: chunksCopied > 0 ? item.rebuilt : 0,
      parityMissing: state === 'done' ? item.parityMissing : 0,
      chunksSynced,
      postsMade: chunksCopied,
      bytesCopied: Math.round((chunksCopied / item.chunks) * item.bytes),
    };
  });
}

/** What was copied stays: a quality done is complete, one begun is partial, and one archived before keeps its copy. */
function cancelArchiveJob(job, now = Date.now()) {
  const row = streams.get(job.streamId);
  if (row && job.target.kind === 'stamp') {
    const copies = archiveCopies.get(row.id) ?? new Map();
    for (const item of archiveJobItems(job, now)) {
      const before = copies.get(item.rendition);
      if (item.chunksCopied === 0 || ARCHIVE_JOB_ARCHIVED.has(before?.state)) continue;
      copies.set(item.rendition, {
        rendition: item.rendition,
        state: item.state === 'done' ? 'complete' : 'partial',
        batchId: job.target.batchId,
        batchLabel: job.target.label,
        chunks: item.chunksCopied,
        bytes: item.bytesCopied,
        parityMissing: 0,
        completedAt: item.state === 'done' ? new Date(now).toISOString() : null,
        completedBy: item.state === 'done' ? job.startedBy : null,
      });
    }
    if (copies.size > 0) archiveCopies.set(row.id, copies);
  }
  mockArchive = null;
}

function archiveJobActions(job, dismissed) {
  switch (job.state) {
    case 'measuring':
    case 'buying':
    case 'waiting_usable':
    case 'copying':
    case 'verifying':
      return ['pause', 'cancel'];
    case 'awaiting_purchase':
      return ['use_stamp', 'cancel'];
    case 'waiting':
      return ['cancel'];
    case 'paused':
      if (job.pauseReason === 'live') return ['wait', 'cancel'];
      if (job.pauseReason === 'batch') return ['resume', 'use_stamp', 'buy_new', 'cancel'];
      return ['resume', 'cancel'];
    default:
      return dismissed ? [] : ['dismiss'];
  }
}

/** The stamp the buy dialog opens on: the smallest depth that holds the recording with the margin, for 30 days. */
function archiveJobProposal(job) {
  const chunkCount = archiveJobChunks(job);
  const needed = Math.ceil(chunkCount * ARCHIVE_JOB_MARGIN);
  const depth = Object.keys(ARCHIVE_JOB_CAPACITY_BYTES)
    .map(Number)
    .find((candidate) => archiveJobChunksAt(candidate) >= needed);
  const terms = archiveJobBuyTerms();
  const costPlur = depth === undefined ? null : archiveJobCost(depth, terms.defaultDays);
  const missing = costPlur === null ? 0n : BigInt(costPlur) - BigInt(terms.walletXbzzPlur);
  return {
    chunkCount,
    depth: depth ?? null,
    days: terms.defaultDays,
    costPlur,
    shortfallPlur: missing > 0n ? missing.toString() : null,
    terms,
  };
}

/** Why a confirmed stamp cannot be bought, as the API's `archiveBuyProblem` words it, or null. */
function archiveJobPurchaseRefusal(job, choice) {
  const depth = Number(choice.depth);
  const days = Number(choice.days);
  const holds = archiveJobChunksAt(depth);
  const needed = Math.ceil(archiveJobChunks(job) * ARCHIVE_JOB_MARGIN);
  if (holds === 0) return { problem: 'purchase_refused', message: "An archive stamp's depth is 17 to 41." };
  if (holds < needed) {
    return {
      problem: 'purchase_refused',
      message: `A stamp of depth ${depth} holds ${holds} chunks, and this recording needs ${needed}.`,
    };
  }
  if (!Number.isSafeInteger(days) || days < 2) {
    return { problem: 'purchase_refused', message: 'A new archive stamp lasts 2 days or more.' };
  }
  const cost = archiveJobCost(depth, days);
  if (cost !== String(choice.costPlur)) {
    return {
      problem: 'price_moved',
      message: `The price of postage moved, and this stamp now costs ${cost} PLUR. Confirm it again at that cost.`,
    };
  }
  return null;
}

function archiveJobSummary(job, user, now = Date.now()) {
  const row = job ? streams.get(job.streamId) : null;
  if (!job || !row) return null;
  const items = archiveJobItems(job, now);
  const chunksTotal = job.measured ? archiveJobChunks(job) : null;
  const chunksCopied = items.reduce((sum, item) => sum + item.chunksCopied, 0);
  const estimate = (key) =>
    job.measured ? job.items.reduce((sum, item) => sum + BigInt(item[key]), 0n).toString() : null;
  const dismissed = job.dismissedBy.has(user.id);
  let secondsLeft = null;
  if (job.state === 'copying')
    secondsLeft = Math.round(((1 - archiveJobCopied(job, now)) * ARCHIVE_JOB_COPY_MS) / 1000);
  if (job.state === 'verifying')
    secondsLeft = Math.max(0, Math.round((ARCHIVE_JOB_VERIFY_MS - (now - job.since)) / 1000));
  return {
    id: job.id,
    streamId: job.streamId,
    streamTitle: row.title,
    state: job.state,
    pauseReason: job.pauseReason,
    pauseMessage: job.pauseMessage,
    pausedAt: job.pausedAt,
    holdsPlace: archiveJobHoldsPlace(job),
    target: job.target,
    proposal: job.state === 'awaiting_purchase' ? archiveJobProposal(job) : null,
    items,
    chunksTotal,
    chunksCopied,
    bytesCopied: items.reduce((sum, item) => sum + item.bytesCopied, 0),
    // The pace of the mock's own clock, which copies a recording in a minute.
    chunksPerSecond:
      job.state === 'copying' && chunksTotal !== null ? chunksTotal / (ARCHIVE_JOB_COPY_MS / 1000) : null,
    secondsLeft,
    bzzEstimateLowPlur: estimate('bzzLowPlur'),
    bzzEstimateHighPlur: estimate('bzzHighPlur'),
    chequebookAvailablePlur: job.chequebookPlur,
    bzzSpentPlur: job.state === 'done' ? estimate('bzzLowPlur') : null,
    startedBy: job.startedBy,
    startedByYou: user.id === job.startedByUserId,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    dismissed,
    actions: archiveJobActions(job, dismissed),
  };
}

/** Why no archive of this stream can start now, or null: a stream that is not a finished recording, or a busy place. */
function archiveJobRefusal(row) {
  if (!((row.status === 'vod' || row.status === 'draft') && row.manifestIndex !== null)) {
    return {
      problem: 'not_finished',
      message: `Only a finished recording can be archived, and this stream is ${row.status}.`,
    };
  }
  if (mockArchive && mockArchive.state !== 'done') {
    const title = streams.get(mockArchive.streamId)?.title ?? 'a stream';
    return {
      problem: 'busy',
      message: `The archive of "${title}" is not finished, started by ${mockArchive.startedBy}. One archive exists at a time.`,
    };
  }
  if (mockExport && mockExport.state !== 'done') {
    const title = streams.get(mockExport.streamId)?.title ?? 'a stream';
    return {
      problem: 'busy',
      message: `The export of "${title}" (${mockExport.quality}) is under way, started by ${mockExport.startedBy}. One job runs at a time, an export or an archive.`,
    };
  }
  return null;
}

function archiveJobOptions(row, user, now = Date.now()) {
  const seconds = row.durationSeconds ?? null;
  const copies = archiveCopies.get(row.id) ?? new Map();
  const summary = streamArchiveSummaryOf(row) ?? { state: 'none', archived: [], archivedOnly: false };
  return {
    streamId: row.id,
    title: row.title,
    date: (row.liveSince ?? row.scheduledStartTime ?? '').slice(0, 10) || null,
    qualities: EXPORT_QUALITIES.map((q) => {
      const copy = copies.get(q.rendition) ?? null;
      const estimate = seconds ? archiveJobEstimate(q, seconds) : null;
      const archived = ARCHIVE_JOB_ARCHIVED.has(copy?.state);
      return {
        rendition: q.rendition,
        label: q.rendition,
        width: q.width,
        height: q.height,
        durationSeconds: seconds,
        state: copy?.state ?? 'none',
        batchId: copy?.batchId ?? null,
        batchLabel: copy?.batchLabel ?? null,
        chunks: copy?.chunks ?? null,
        bytes: copy?.bytes ?? null,
        parityMissing: copy?.parityMissing ?? 0,
        completedAt: copy?.completedAt ?? null,
        completedBy: copy?.completedBy ?? null,
        estimatedChunks: estimate?.chunks ?? null,
        estimatedBytes: estimate?.bytes ?? null,
        estimatedBzzLowPlur: estimate?.bzzLowPlur ?? null,
        estimatedBzzHighPlur: estimate?.bzzHighPlur ?? null,
        estimatedSeconds: estimate?.seconds ?? null,
        unavailable: archived ? 'Archived already, at the recording it holds now.' : null,
      };
    }),
    stamps: archiveJobStamps.map((stamp) => archiveJobStampAnswer(stamp, now)).filter((stamp) => stamp.writable),
    buy: archiveJobBuyTerms(),
    chequebookAvailablePlur: mockArchive?.chequebookPlur ?? ARCHIVE_JOB_CHEQUEBOOK_PLUR,
    summary,
    canListArchivedOnly: summary.archived.length > 0,
    archivedOnlyHint:
      row.id === archiveHintStreamId && !summary.archivedOnly
        ? 'The stage batch that holds 480p and 360p has expired, so those qualities no longer play. Turn on "List only archived qualities" so the catalogue offers only the qualities that do.'
        : null,
    refusal: archiveJobRefusal(row),
    current: archiveJobSummary(mockArchive, user, now),
  };
}

/** The Archive page: the streams that have a copy, newest copy first. */
function archivedStreamsAnswer(now = Date.now()) {
  const list = [];
  for (const [streamId, copies] of archiveCopies) {
    const row = streams.get(streamId);
    if (!row || copies.size === 0) continue;
    const qualities = [...copies.values()].map((copy) => {
      const stamp = archiveJobStamps.find((candidate) => candidate.batchId === copy.batchId);
      return {
        rendition: copy.rendition,
        label: copy.rendition,
        state: copy.state,
        batchId: copy.batchId,
        batchLabel: copy.batchLabel,
        bytes: copy.bytes,
        parityMissing: copy.parityMissing,
        batchTtlSeconds: stamp ? archiveJobStampAnswer(stamp, now).ttlSeconds : null,
      };
    });
    const archived = [...copies.values()].filter((copy) => ARCHIVE_JOB_ARCHIVED.has(copy.state));
    const newest = [...copies.values()]
      .filter((copy) => copy.completedAt !== null)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
    list.push({
      streamId,
      title: row.title,
      date: (row.liveSince ?? row.scheduledStartTime ?? '').slice(0, 10) || null,
      summary: streamArchiveSummaryOf(row),
      qualities,
      bytes: archived.reduce((sum, copy) => sum + copy.bytes, 0),
      archivedAt: newest?.completedAt ?? null,
      archivedBy: newest?.completedBy ?? null,
    });
  }
  list.sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));
  return { streams: list };
}

/** A recording that ended `endedMinutesAgo` before the start, finalized as the boot run would have. */
function seedArchivedRecording(title, description, endedMinutesAgo) {
  seedStream(
    { title, description, scheduledStartTime: minutesBefore(endedMinutesAgo + 65) },
    {
      status: 'vod',
      publishedAt: minutesBefore(endedMinutesAgo + 70),
      liveSince: minutesBefore(endedMinutesAgo + 65),
      endedAt: minutesBefore(endedMinutesAgo),
      durationSeconds: 3600,
      manifestIndex: 360,
      createdAt: minutesBefore(endedMinutesAgo + 80),
      updatedAt: minutesBefore(endedMinutesAgo),
    },
  );
  const row = [...streams.values()].at(-1);
  finish(row, minutesBefore(endedMinutesAgo - 30));
  return row;
}

// Every recording carries an archive of its own, whichever MOCK_ARCHIVE is: the first none, as the job's stream; the
// second archived, with a hint to list only its archived qualities; and five more, seeded here, one of each other state.
{
  const [roomy, nearlyFull, expired] = archiveJobStamps;
  const [, archivedRecording] = [...streams.values()].filter((r) => r.status === 'vod' && r.manifestIndex !== null);
  const by = EXPORT_OTHER_USER.username;
  const DAY = 24 * 60;
  if (archivedRecording) {
    setArchiveCopies(archivedRecording, [
      archiveCopy(archivedRecording, '1080p', 'complete', roomy, by),
      archiveCopy(archivedRecording, '720p', 'complete', roomy, by),
    ]);
    archiveHintStreamId = archivedRecording.id;
  }
  const workshop = seedArchivedRecording(
    'Workshop recording',
    'Seeded with an archive whose 1080p lost parity chunks before the copy: archived, with reduced protection.',
    5 * DAY,
  );
  setArchiveCopies(workshop, [archiveCopy(workshop, '1080p', 'reduced', roomy, by, { parityMissing: 12 })]);
  const panel = seedArchivedRecording(
    'Panel discussion',
    'Seeded with an archive of 720p that stopped before it was complete.',
    8 * DAY,
  );
  setArchiveCopies(panel, [archiveCopy(panel, '720p', 'partial', nearlyFull, by)]);
  const keynote = seedArchivedRecording(
    'Keynote, recorded twice',
    'Seeded with an archive of 1080p made before the stream recorded again: the copy is outdated.',
    12 * DAY,
  );
  setArchiveCopies(keynote, [archiveCopy(keynote, '1080p', 'outdated', roomy, by)]);
  const meetup = seedArchivedRecording(
    "Last year's meetup",
    'Seeded with an archive of 1080p on a stamp that has expired.',
    40 * DAY,
  );
  setArchiveCopies(meetup, [archiveCopy(meetup, '1080p', 'expired', expired, by)]);
  const conference = seedArchivedRecording(
    'Conference opening',
    'Seeded with an archive of 1080p on a stamp the manager no longer lists.',
    20 * DAY,
  );
  // A stamp that is in no listing, as one removed in the manager is.
  const removed = archiveJobStamp('Removed archive', 21, 300_000, 120);
  setArchiveCopies(conference, [archiveCopy(conference, '1080p', 'unlisted', removed, by)]);
}

// The archive seeded at start, of the first seeded recording, MOCK_ARCHIVE deciding which.
{
  const recording = [...streams.values()].find((r) => r.status === 'vod' && r.manifestIndex !== null);
  const seeded = [...users.values()][0] ?? EXPORT_OTHER_USER;
  const [roomy, nearlyFull] = archiveJobStamps;
  const onStamp = (stamp) => ({ kind: 'stamp', batchId: stamp.batchId, label: stamp.label });
  const both = ['1080p', '720p'];
  const copied = (fraction) => ({ measured: true, copyMs: fraction * ARCHIVE_JOB_COPY_MS, state: 'copying' });
  const paused = (reason, message, fraction = 0.4) => ({
    ...copied(fraction),
    state: 'paused',
    resumeTo: 'copying',
    pauseReason: reason,
    pauseMessage: message,
    pausedAt: new Date().toISOString(),
  });
  const seeds = {
    measuring: () => newArchiveJob(recording, both, onStamp(roomy), EXPORT_OTHER_USER),
    copying: () => newArchiveJob(recording, both, onStamp(roomy), EXPORT_OTHER_USER, copied(0.3)),
    verifying: () =>
      newArchiveJob(recording, both, onStamp(roomy), EXPORT_OTHER_USER, { ...copied(1), state: 'verifying' }),
    awaiting_purchase: () =>
      newArchiveJob(recording, both, { kind: 'purchase', purchase: null }, seeded, {
        measured: true,
        state: 'awaiting_purchase',
      }),
    buying: () => {
      const job = newArchiveJob(recording, both, { kind: 'purchase', purchase: null }, seeded, { measured: true });
      const depth = archiveJobProposal(job).depth ?? 22;
      job.target.purchase = {
        id: randomUUID(),
        depth,
        days: 30,
        amountPerChunkPlur: archiveJobAmountPerChunk(30).toString(),
        costPlur: archiveJobCost(depth, 30),
        label: 'Keynotes 2026',
        state: 'buying',
        batchId: null,
        error: null,
        startedBy: seeded.username,
        startedAt: new Date().toISOString(),
      };
      job.state = 'buying';
      return job;
    },
    paused_user: () =>
      newArchiveJob(recording, both, onStamp(roomy), seeded, paused('user', `Paused by ${seeded.username}.`)),
    paused_unreadable: () =>
      newArchiveJob(
        recording,
        both,
        onStamp(roomy),
        seeded,
        paused(
          'unreadable',
          'A data chunk of segment 212 of 1080p was neither read nor rebuilt from its parity, after 3 tries.',
        ),
      ),
    paused_batch: () =>
      newArchiveJob(
        recording,
        both,
        onStamp(nearlyFull),
        seeded,
        paused(
          'batch',
          'The archive stamp “Short talks” lacks room for what is left. Use another stamp, buy a new one, or dilute this one and try again.',
          0.1,
        ),
      ),
    paused_funds: () =>
      newArchiveJob(recording, both, onStamp(roomy), seeded, {
        ...paused(
          'funds',
          "The catalogue node's chequebook holds 0.40 xBZZ, under the floor of 1 xBZZ. Fund it on the Funding page's Chequebooks tab, then try again.",
        ),
        chequebookPlur: ARCHIVE_JOB_THIN_CHEQUEBOOK_PLUR,
      }),
    paused_node: () =>
      newArchiveJob(
        recording,
        both,
        onStamp(roomy),
        seeded,
        paused('node', 'The catalogue node does not answer. Try again once it does.'),
      ),
    waiting: () => newArchiveJob(recording, both, onStamp(roomy), seeded, { ...copied(0.5), state: 'waiting' }),
    done: () => {
      const job = newArchiveJob(recording, both, onStamp(roomy), EXPORT_OTHER_USER, copied(1));
      finishArchiveJob(job);
      return job;
    },
    done_reduced: () => {
      const job = newArchiveJob(recording, both, onStamp(roomy), EXPORT_OTHER_USER, copied(1));
      job.items[0].parityMissing = 12;
      finishArchiveJob(job);
      return job;
    },
  };
  if (recording && Object.hasOwn(seeds, MOCK_ARCHIVE)) mockArchive = seeds[MOCK_ARCHIVE]();
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
      defaultTheme,
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
    const key = `${name}@${req.socket.remoteAddress ?? 'unknown'}`;
    if ((failures.get(key) ?? 0) > LOCKOUT_FREE_ATTEMPTS) {
      return send(
        res,
        429,
        { error: 'too_many_attempts', retryAfterSeconds: LOCKOUT_SECONDS },
        { 'retry-after': String(LOCKOUT_SECONDS) },
      );
    }

    const row = byUsername(name);
    if (row === null || passwords.get(row.id) !== body.password) {
      failures.set(key, (failures.get(key) ?? 0) + 1);
      return send(res, 401, { error: 'invalid_credentials' });
    }

    failures.delete(key);
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

  // Exporting a recording: the export on the server, what can be done to it, and its file.
  if (path === '/api/export' || path.startsWith('/api/export/')) settleExport();
  if (path === '/api/export' && method === 'GET') {
    return send(res, 200, { export: exportSummary(mockExport, user) }, { 'cache-control': 'no-store' });
  }
  const exportRoute = /^\/api\/export\/([^/]+)\/(actions|file)$/.exec(path);
  if (exportRoute) {
    const e = mockExport;
    if (!e || e.id !== exportRoute[1]) return send(res, 404, { error: 'export_not_found', id: exportRoute[1] });
    if (exportRoute[2] === 'file' && method === 'GET') {
      if (e.state !== 'done') return send(res, 404, { error: 'export_not_found', id: e.id });
      const body = Buffer.from('The mock API exports no video: this file only stands in for the MP4.\n');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': body.length,
        'content-disposition': `attachment; filename="${e.fileName}"`,
        'cache-control': 'no-store',
      });
      return res.end(body);
    }
    if (exportRoute[2] === 'actions' && method === 'POST') {
      const { action } = await readJson(req);
      if (!exportActions(e, e.dismissedBy.has(user.id)).includes(action)) {
        return send(res, 409, {
          error: 'export_refused',
          problem: 'not_now',
          message: `The export cannot ${action} now.`,
        });
      }
      const now = Date.now();
      const cleared = { pauseReason: null, pauseMessage: null, pausedAt: null };
      if (action === 'pause') pauseExport(e, 'user', `Paused by ${user.username}.`, now);
      if (action === 'resume') Object.assign(e, { state: 'reading', since: now, failAt: null, ...cleared });
      if (action === 'wait') Object.assign(e, { state: 'waiting', ...cleared });
      if (action === 'save') {
        e.partial = readFraction(e, now) < 1 || e.pauseReason === 'unreadable';
        Object.assign(e, { state: 'joining', since: now, ...cleared });
      }
      if (action === 'dismiss') e.dismissedBy.add(user.id);
      if (action === 'cancel' || action === 'clear') mockExport = null;
      return send(res, 200, { export: exportSummary(mockExport, user) });
    }
  }

  // Archiving a recording: the archive on the server, what can be done to it, and the streams that have one.
  if (path === '/api/archive' || path.startsWith('/api/archive/')) settleArchiveJob();
  if (path === '/api/archive' && method === 'GET') {
    return send(res, 200, { archive: archiveJobSummary(mockArchive, user) }, { 'cache-control': 'no-store' });
  }
  if (path === '/api/archive/streams' && method === 'GET') return send(res, 200, archivedStreamsAnswer());
  // No password: the catalogue node pays from its own wallet, as for a top-up.
  if (path === '/api/archive/current/confirm-purchase' && method === 'POST') {
    const job = mockArchive;
    if (!job || job.state !== 'awaiting_purchase') {
      return send(res, 409, {
        error: 'archive_refused',
        problem: 'not_now',
        message: 'No archive waits for a new stamp to be confirmed.',
      });
    }
    const choice = await readJson(req);
    const refusal = archiveJobPurchaseRefusal(job, choice);
    if (refusal) return send(res, 409, { error: 'archive_refused', ...refusal });
    const label = typeof choice.label === 'string' && choice.label.trim() !== '' ? choice.label.trim() : null;
    job.target = {
      kind: 'purchase',
      purchase: {
        id: randomUUID(),
        depth: Number(choice.depth),
        days: Number(choice.days),
        amountPerChunkPlur: archiveJobAmountPerChunk(Number(choice.days)).toString(),
        costPlur: String(choice.costPlur),
        label,
        state: 'buying',
        batchId: null,
        error: null,
        startedBy: user.username,
        startedAt: new Date().toISOString(),
      },
    };
    Object.assign(job, { state: 'buying', since: Date.now() });
    return send(res, 200, { archive: archiveJobSummary(job, user) });
  }
  const archiveRoute = /^\/api\/archive\/([^/]+)\/actions$/.exec(path);
  if (archiveRoute && method === 'POST') {
    const job = mockArchive;
    if (!job || job.id !== archiveRoute[1]) return send(res, 404, { error: 'archive_not_found', id: archiveRoute[1] });
    const body = await readJson(req);
    const action = body.action;
    if (!archiveJobActions(job, job.dismissedBy.has(user.id)).includes(action)) {
      return send(res, 409, {
        error: 'archive_refused',
        problem: 'not_now',
        message: `The archive cannot ${action} now.`,
      });
    }
    const now = Date.now();
    const cleared = { pauseReason: null, pauseMessage: null, pausedAt: null };
    if (action === 'use_stamp') {
      const stamp = archiveJobStamps.find((candidate) => candidate.batchId === body.batchId);
      if (!stamp || stamp.expiresAt <= now) {
        return send(res, 409, {
          error: 'archive_refused',
          problem: 'stamp_unusable',
          message: 'That archive stamp cannot be written. Pick another, or buy a new one.',
        });
      }
      const target = { kind: 'stamp', batchId: stamp.batchId, label: stamp.label };
      Object.assign(job, { target, state: job.measured ? 'copying' : 'measuring', since: now, ...cleared });
    }
    if (action === 'pause') pauseArchiveJob(job, 'user', `Paused by ${user.username}.`, now);
    if (action === 'resume') {
      const state = job.resumeTo ?? 'copying';
      Object.assign(job, { state, since: now, chequebookPlur: ARCHIVE_JOB_CHEQUEBOOK_PLUR, ...cleared });
    }
    if (action === 'wait') Object.assign(job, { state: 'waiting', since: now, ...cleared });
    if (action === 'buy_new') {
      const target = { kind: 'purchase', purchase: null };
      Object.assign(job, { target, state: 'awaiting_purchase', since: now, ...cleared });
    }
    if (action === 'dismiss') job.dismissedBy.add(user.id);
    if (action === 'cancel') cancelArchiveJob(job, now);
    return send(res, 200, { archive: archiveJobSummary(mockArchive, user) });
  }

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

  if (path === '/api/archive/stamps' && method === 'GET') return send(res, 200, archiveStampsAnswer());

  // No password: the catalogue node pays from its own wallet, as for a top-up.
  if (path === '/api/archive/stamp-purchases' && method === 'POST') {
    if (ARCHIVE_STAMPS_SEED === 'unoffered') {
      return send(res, 409, {
        error: 'archive_refused',
        problem: 'purchases_not_offered',
        message: ARCHIVE_PURCHASES_NOT_OFFERED,
      });
    }
    const choice = await readJson(req);
    const refusal = archivePurchaseRefusal(choice);
    if (refusal) return send(res, 409, { error: 'archive_refused', ...refusal });
    const id = randomUUID();
    const amount = archiveAmountPerChunk(choice.days);
    const purchase = {
      id,
      depth: choice.depth,
      days: choice.days,
      amountPerChunkPlur: amount.toString(),
      costPlur: choice.costPlur,
      label: choice.label === null ? null : choice.label.trim(),
      batchId: `0x${hex(32)}`,
      error: FUNDING_REFUSE ? 'The node refused the purchase, so nothing was spent.' : null,
      startedBy: user.username,
      startedAt: new Date().toISOString(),
      requestedAt: Date.now(),
      boughtAt: null,
      failed: FUNDING_REFUSE,
      settled: false,
    };
    archivePurchases.set(id, purchase);
    return send(res, 202, archivePurchaseAnswer(purchase));
  }

  const purchaseMatch = /^\/api\/archive\/stamp-purchases\/([^/]+)$/.exec(path);
  if (purchaseMatch && method === 'GET') {
    const purchase = archivePurchases.get(decodeURIComponent(purchaseMatch[1]));
    if (!purchase) return send(res, 404, { error: 'not_found', path });
    return send(res, 200, archivePurchaseAnswer(purchase));
  }

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
        cost: item.kind === 'topup' ? topUpCost(item.days, nodeBatch(node, item.batchId).depth) : 0n,
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

  if (path === '/api/funding/chequebook-operations' && method === 'GET') {
    const items = chequebookBulks.get(url.searchParams.get('bulkId') ?? '');
    if (!items) return send(res, 404, { error: 'not_found', path });
    settleChequebookOperations();
    return send(res, 200, { items: items.map(chequebookItemAnswer) });
  }

  // No password: a chequebook operation pays from the node's own wallet, so the page asks in a confirm dialog alone.
  // One chequebook bulk at a time, as the API has it, whatever a send or a stamp bulk is doing. A refusal is the API's
  // own answer to a check that failed: 409 funding_refused with its sentence.
  if (path === '/api/funding/chequebook-operations' && method === 'POST') {
    if (!FUNDING_CONFIGURED) return send(res, 404, { error: 'not_found', path });
    const body = await readJson(req);
    settleChequebookOperations();
    if (openChequebookBulkId() !== null) return send(res, 409, { error: 'conflict' });
    const refusal = chequebookRefusal(body);
    if (refusal) return send(res, 409, { error: 'funding_refused', problem: 'chequebook', message: refusal });
    const bulkId = randomUUID();
    const requestedAt = Date.now();
    const target = BigInt(body.targetPlur);
    const items = body.items.map((item, index) => {
      const node = fundingNodes.get(item.nodeId);
      const move = chequebookMoveNow(target, BigInt(item.availablePlur), node.chequebook.availablePlur);
      return {
        requestId: randomUUID(),
        index,
        nodeId: node.nodeId,
        nodeLabel: node.label,
        direction: move.direction,
        amount: move.amount,
        target,
        state: FUNDING_REFUSE ? 'failed' : FUNDING_LOST ? 'unknown' : 'queued',
        txHash: FUNDING_LOST ? `0x${hex(32)}` : null,
        error: FUNDING_REFUSE ? CHEQUEBOOK_REFUSED : null,
        mined: false,
        watched: FUNDING_LOST,
        requestedAt,
      };
    });
    chequebookBulks.set(bulkId, items);
    settleChequebookOperations();
    return send(res, 202, { bulkId, items: items.map(chequebookItemAnswer) });
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

  // The sweep, before anything about a stream is answered.
  if (path === '/api/streams' || path.startsWith('/api/streams/')) finishEnded();

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

  if (sub === '/export' && method === 'GET') {
    settleExport();
    return send(res, 200, exportOptions(row, user), { 'cache-control': 'no-store' });
  }

  if (sub === '/export' && method === 'POST') {
    settleExport();
    const refusal = exportRefusal(row);
    if (refusal) return send(res, 409, { error: 'export_refused', ...refusal });
    const { rendition } = await readJson(req);
    if (!EXPORT_QUALITIES.some((q) => q.rendition === rendition)) {
      return send(res, 409, {
        error: 'export_refused',
        problem: 'quality_unavailable',
        message: `This recording has no ${rendition}.`,
      });
    }
    mockExport = newExport(row, rendition, user, { failAt: MOCK_EXPORT === 'paused' ? 0.6 : null });
    return send(res, 201, exportSummary(mockExport, user));
  }

  if (sub === '/archive' && method === 'GET') {
    settleArchiveJob();
    return send(res, 200, archiveJobOptions(row, user), { 'cache-control': 'no-store' });
  }

  if (sub === '/archive' && method === 'POST') {
    settleArchiveJob();
    const refusal = archiveJobRefusal(row);
    if (refusal) return send(res, 409, { error: 'archive_refused', ...refusal });
    const { renditions, target } = await readJson(req);
    const copies = archiveCopies.get(row.id);
    const picked = Array.isArray(renditions)
      ? renditions.filter((rendition) => EXPORT_QUALITIES.some((q) => q.rendition === rendition))
      : [];
    const open = picked.filter((rendition) => {
      const state = copies?.get(rendition)?.state;
      return state !== 'complete' && state !== 'reduced';
    });
    if (open.length === 0) {
      return send(res, 409, {
        error: 'archive_refused',
        problem: 'nothing_to_archive',
        message: 'Every quality picked is archived already, at the recording it holds now.',
      });
    }
    let jobTarget = { kind: 'purchase', purchase: null };
    if (target?.buyNew !== true) {
      const stamp = archiveJobStamps.find((candidate) => candidate.batchId === target?.batchId);
      if (!stamp || stamp.expiresAt <= Date.now()) {
        return send(res, 409, {
          error: 'archive_refused',
          problem: 'no_stamp',
          message: 'That archive stamp cannot be written. Pick another, or buy a new one.',
        });
      }
      jobTarget = { kind: 'stamp', batchId: stamp.batchId, label: stamp.label };
    }
    mockArchive = newArchiveJob(row, open, jobTarget, user);
    return send(res, 202, { archive: archiveJobSummary(mockArchive, user) });
  }

  if (sub === '/archive/listing' && method === 'PUT') {
    const { archivedOnly } = await readJson(req);
    const archived = streamArchiveSummaryOf(row)?.archived ?? [];
    if (archivedOnly === true && archived.length === 0) {
      return send(res, 409, {
        error: 'archive_refused',
        problem: 'not_now',
        message: 'The switch is offered once one quality plays from an archive stamp.',
      });
    }
    if (archivedOnly === true) archivedOnlyStreams.add(row.id);
    else archivedOnlyStreams.delete(row.id);
    // The catalogue entry is written again, as a republish writes it.
    if (ON_FEED_STATUSES.includes(row.status)) {
      feedIndex += 1;
      row.publishedFeedIndex = feedIndex;
    }
    return send(res, 200, archiveJobOptions(row, user));
  }

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
    // Its export goes with it, as the API's foreign key takes it, and so do its archive and its copies' records.
    if (mockExport?.streamId === row.id) mockExport = null;
    if (mockArchive?.streamId === row.id) mockArchive = null;
    archiveCopies.delete(row.id);
    archivedOnlyStreams.delete(row.id);
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

  if (sub === '/finish' && method === 'POST') {
    // Finalize, and the API's three refusals: a live stream, one that never
    // went live, and one already finalized. Each body is the API's.
    if (row.status === 'live') {
      return send(res, 409, { error: 'stream_live', id: row.id, message: 'Stop the broadcast first.' });
    }
    if (row.status !== 'vod') {
      return send(res, 409, {
        error: 'stream_not_started',
        id: row.id,
        message: 'Only an ended stream can be finalized.',
      });
    }
    if (row.finishedAt !== null) {
      return send(res, 409, {
        error: 'stream_finished',
        id: row.id,
        message: 'This stream is already finalized: its key has changed.',
      });
    }
    finish(row, new Date().toISOString());
    return send(res, 200, { stream: publicStream(row), ingest: ingestDetails(row) });
  }

  return send(res, 404, { error: 'not_found', path });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-api] listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-api] log in as ${SEED_USERNAME} / ${seedPassword}`);
  console.log(
    `[mock-api] stages: ${stages.length === 0 ? 'none (MOCK_NO_STAGES)' : stages.map((stage) => stage.name).join(', ')}`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
