import { PrivateKey } from '@ethersphere/bee-js';
import path from 'path';

// Side-effect import, and it must stay ahead of every other local import. `utils/env.js` runs
// `dotenv.config()` at module scope, and anything that reads `process.env` while being imported gets
// whatever the real environment held before the `.env` file was applied. `Logger` did exactly that,
// through `utils/common.js`, so `LOG_LEVEL` in the root `.env` was read too late and ignored, with
// no way for an operator to tell. `simple-import-sort` places side-effect imports ahead of the
// relative groups, so the ordering this depends on is the one the linter already enforces, and
// `test/envLoadOrder.test.ts` fails if it stops holding.
import './utils/env.js';

import { startApiServer } from './api/server.js';
import { loadEngines } from './engines/load.js';
import { AdminApiClient } from './libs/AdminApiClient.js';
import { AdminLadderRegistry } from './libs/AdminLadderRegistry.js';
import { assertAdminSignsAsThisService } from './libs/AdminOwnerCheck.js';
import { BeePublisherPool, safeUrl } from './libs/BeePublisherPool.js';
import { CatalogIndexStore } from './libs/CatalogIndexStore.js';
import { bzzToPlur, ChequebookGate, ChequebookNode, FundingLogger } from './libs/ChequebookGate.js';
import { ChequebookRecheck } from './libs/ChequebookRecheck.js';
import { ClockCheck } from './libs/ClockCheck.js';
import { LadderGroupStore } from './libs/LadderGroupStore.js';
import { LadderRegistry } from './libs/LadderRegistry.js';
import { Logger } from './libs/Logger.js';
import { assertNodeReachable, waitForNode } from './libs/NodeWait.js';
import { PostageGate } from './libs/PostageGate.js';
import { registerCrashHandlers, registerShutdownSignals } from './libs/processSignals.js';
import { RecordingStore } from './libs/RecordingStore.js';
import { RecoveryStore } from './libs/RecoveryStore.js';
import { ServiceLifecycle } from './libs/ServiceLifecycle.js';
import { runStartGates, StartGate } from './libs/StartGates.js';
import { StreamCatalog } from './libs/StreamCatalog.js';
import { StreamOrchestrator } from './libs/StreamOrchestrator.js';
import { config } from './utils/config.js';
import { NodeWaitReport } from './types.js';

/** The gate's floor is configured in hours, because that is the unit an operator tops a batch up in. */
const SECONDS_PER_HOUR = 3_600;

const logger = Logger.getInstance();
const lifecycle = new ServiceLifecycle((code) => process.exit(code), logger);

registerShutdownSignals(lifecycle);
registerCrashHandlers(logger);

/**
 * Which Bee nodes this stage publishes through.
 *
 * BEE_PUBLISHERS unset is the single-node deployment: one node, one batch, everything through it.
 * Set, it is one node per rung, and every rung of ABR_LADDER must appear, which only means
 * anything with a ladder to map onto, hence the refusal below rather than silently ignoring it.
 */
function buildPublishers(requestTimeoutMs: number): BeePublisherPool {
  if (config.publishers.length === 0) {
    return BeePublisherPool.single(config.beeUrl, config.stamp, requestTimeoutMs);
  }

  if (!config.abr) {
    throw new Error('BEE_PUBLISHERS is set but ABR_ENABLED is false. Per-rung publishers have no ladder to map onto');
  }

  return BeePublisherPool.perRung(
    config.publishers,
    config.abr.ladder.rungs().map((rung) => rung.name),
    requestTimeoutMs,
  );
}

/**
 * The admin service this uploader answers to, or undefined for the standalone deployment.
 *
 * Constructed once and shared, deliberately. The engines' publish gate resolves declarations through
 * it and each uploader reports state through it, and those two pointed at different admins is a
 * deployment where a broadcast is admitted by one service and reported to another. See
 * {@link AdminApiClient}.
 */
function buildAdminApi(): AdminApiClient | undefined {
  if (!config.admin) {
    logger.info('[Admin] ADMIN_API_URL is not set, running standalone: the stream catalog on Swarm is ours to write');
    return undefined;
  }

  logger.info(
    `[Admin] Admin mode against ${config.admin.apiUrl}: streams are declared there, publishes are resolved ` +
      'and authenticated against those declarations, and this service writes no stream catalog entries',
  );
  return new AdminApiClient({ baseUrl: config.admin.apiUrl, token: config.admin.apiToken });
}

/**
 * The chequebook gate over the given nodes, one definition for the boot's pass and for the reads
 * `ChequebookRecheck` makes after it, so the two cannot drift apart. The reads after the boot hand it a
 * logger that files a funded node at debug, because while one rung waits for its deposit a line per
 * funded rung every minute would bury the line that matters.
 */
function chequebookGate(nodes: readonly ChequebookNode[], fundingLogger: FundingLogger): StartGate {
  return {
    name: 'ChequebookGate',
    refuses: config.startGates.chequebookRefuses,
    run: (collect) =>
      new ChequebookGate(nodes, bzzToPlur(config.chequebookMinBzz), fundingLogger).assertFunded(collect),
  };
}

async function start() {
  try {
    const publishers = buildPublishers(config.beeRequestTimeoutMs);
    const adminApi = buildAdminApi();
    const signerOwner = new PrivateKey(config.streamKey).publicKey().address().toHex();
    if (adminApi) {
      await assertAdminSignsAsThisService(adminApi, signerOwner);
    }

    // The gates read the same nodes through their own clients, because a chequebook balance and a
    // postage batch are answered off the chain and neither read has a retry around it. The upload
    // loop's per-request deadline is derived from retry windows that do not apply to either, and
    // lending it to them is what held a live uploader in a restart loop on 2026-09-16.
    //
    // ⛔ The reachability probe reads through this pool too, and that is the point of keeping it
    // rather than only its nodes. Probing through the pool above would give a node four seconds to
    // answer a liveness check while the gates behind it wait twenty, so a node that is merely slow
    // would be waited for forever by a boot whose gates could have cleared it.
    const gatePublishers = buildPublishers(config.startGateTimeoutMs);
    const gateNodes = gatePublishers.nodes();

    const recoveryStore = new RecoveryStore(config.stateDir);

    // In a subdirectory so RecoveryStore's *.json scan of stateDir never picks it up as a stream.
    const catalogIndexStore = new CatalogIndexStore(path.join(config.stateDir, 'catalog', 'feed-index.json'));

    // Also ladder-only, and in a subdirectory for the same reason the catalog index is: RecoveryStore
    // scans stateDir for `*.json` and would otherwise offer this file up as a stream to recover.
    const ladderGroupStore = config.abr
      ? new LadderGroupStore(path.join(config.stateDir, 'ladder', 'groups.json'))
      : undefined;

    // In a subdirectory for the same reason. Kept across restarts so the next broadcast on a declared
    // topic or a rung's topic glues the recording the one before it finished with.
    const recordingStore = new RecordingStore(path.join(config.stateDir, 'recordings', 'by-topic.json'));

    const streamCatalog = new StreamCatalog(publishers, config.streamKey, config.streamListTopic, catalogIndexStore);

    // Where a ladder rung's rendition record goes. Standalone, the catalog: it merges four rungs into
    // one entry on the stream list feed. In admin mode the merge moves into the admin: each rung
    // reports its own record, and the admin writes `renditions` into the catalog entry it already
    // owns. A player builds the ladder's master playlist from those renditions. See
    // `libs/AdminLadderRegistry.ts` and the "Admin mode" section of the package README.
    const ladderRegistry: LadderRegistry =
      adminApi && config.abr ? new AdminLadderRegistry({ client: adminApi }) : streamCatalog;
    if (adminApi && config.abr) {
      logger.info(
        '[Admin] ABR ladder in admin mode: the declared topic is the ladder group, each rung writes its ' +
          'windows on a topic derived from the group and its rung name, and the admin merges the ladder',
      );
    }

    // Started here, beside the boot rather than as a start gate: the start gates are questions about a
    // Bee node, read again on every attempt of the node wait, and holding the boot for a round would buy
    // nothing, because the window writer asks `isTrusted` before every write. Its first round has
    // finished long before the node wait is over, and until then it refuses nothing.
    //
    // The live windows and the list notes ask the same check, so a clock it distrusts skips both.
    const clockCheck = new ClockCheck({ servers: config.clockCheckServers, logger });
    clockCheck.start();
    lifecycle.trackClockCheck(clockCheck);
    const clockTrusted = (): boolean => clockCheck.isTrusted();

    const streamOrchestrator = new StreamOrchestrator(publishers, streamCatalog, recoveryStore, {
      streamKey: config.streamKey,
      maxQueueSize: config.maxQueueSize,
      recoveryTimeout: config.recoveryTimeout,
      orphanReapMs: config.orphanReapMs,
      segmentStallMs: config.segmentStallMs,
      firstRungDeadlineMs: config.firstRungDeadlineMs,
      fragmentSeconds: config.fragmentSeconds,
      segmentDedupWindow: config.segmentDedupWindow,
      segmentRedundancy: config.segmentRedundancy,
      ladder: config.abr?.ladder,
      ladderGroupStore,
      adminApi,
      ladderRegistry,
      clockTrusted,
      recordingStore,
    });

    lifecycle.trackOrchestrator(streamOrchestrator);

    const engines = loadEngines(config.engine, { adminApi, signerOwner });

    // ⛔ Stripped once, here, because a node url may carry basic auth in its userinfo and everything
    // built from this reaches `/health`, which takes no credential of its own. `waitForNode` strips
    // what it publishes too, so neither path depends on the other having remembered.
    const coordinatorUrl = safeUrl(publishers.coordinator().url);

    // Waiting from the first second rather than from the first failed read. The API below listens
    // before anything touches a node, so a probe arriving in between has to be told the boot is not
    // finished. `waitForNode` replaces this with its own report as soon as it starts.
    let nodeWait: NodeWaitReport | null = {
      url: coordinatorUrl,
      waitingSince: new Date().toISOString(),
      attempts: 0,
    };

    // ⛔ Ahead of every Bee-dependent step, so the uploader listens and answers /health while it
    // waits for a node that is not there, rather than exiting. The admin owner check above contacts
    // the admin service, but nothing above asks a Bee node anything. The Bee reads below used to
    // run first, so a node that was not answering meant no listener at all, a container that
    // exited, and a deploy refused on a restart count that was climbing for a reason nothing about
    // this service could fix. See `libs/NodeWait.ts` and `refuseWhileWaiting`.
    const apiServer = startApiServer(streamOrchestrator, config.apiPort, {
      authToken: config.apiAuthToken,
      engines,
      waitingForNode: () => nodeWait,
      clockReport: () => clockCheck.report(),
    });
    lifecycle.trackApiServer(apiServer);

    // The two gates read what is silent when it is wrong. A dry chequebook answers /health in a
    // millisecond while every paid push behind it stalls, and an expired batch, or an immutable one
    // that is full, fails every upload while the node answers and the config reads correctly.
    // BeePublisherPool already rejects a batch id that is malformed or does not cover the ladder, and
    // PostageGate is the half that asks whether the batch it names can still carry anything.
    //
    // Since 2026-09-17 the chequebook gate warns and the uploader starts whatever it found.
    // The postage gate still stops the boot on a batch the node answered about,
    // absent, unusable, expired or, when immutable, full, and only warns about one it could not
    // read at all, a timeout, a 5xx or an answer with no readable fields.
    // UPLOADER_START_GATES=refuse makes both gates refuse both readings. See StartGates for what
    // that cost and why the reading still happens on every boot.
    const recoveredStreamIds = await waitForNode(
      async () => {
        // ⛔ The cheapest question, before anything has to interpret an answer. A node that is not
        // there costs each gate its whole budget and then arrives as a sentence, and it reaches
        // `StreamCatalog.init` as a status that has to be told apart from an empty feed. See
        // `assertNodeReachable`.
        await assertNodeReachable(gatePublishers.coordinator());

        await runStartGates(
          [
            chequebookGate(gateNodes, logger),
            {
              name: 'PostageGate',
              refuses: config.startGates.postageRefuses,
              run: (collect) =>
                new PostageGate(
                  gateNodes,
                  config.stampMinTtlHours * SECONDS_PER_HOUR,
                  config.stampMaxUtilization,
                  logger,
                ).assertUsable(collect),
            },
          ],
          logger,
          (warnings) => streamOrchestrator.recordStartGateWarnings(warnings),
        );

        await streamCatalog.init();
        return streamOrchestrator.recoverStreams();
      },
      {
        url: coordinatorUrl,
        logger,
        onReport: (report) => {
          nodeWait = report;
        },
      },
    );

    // Only now, so nothing reaches an orchestrator whose catalog has never been read.
    nodeWait = null;

    // After init, which settles the index the first note names. Standalone only: in admin mode the
    // admin writes the list and its notes, and notes from here would collide with its own.
    if (!config.admin) {
      streamCatalog.startNotes({ clockTrusted });
      lifecycle.trackListNotes(streamCatalog);
    }

    // Only once the boot is over, because until then the node wait reads the gates again on every
    // attempt of its own. A chequebook warning that pass left is read again until the chequebook is
    // funded, so the warning leaves /health without a restart. See `libs/ChequebookRecheck.ts`.
    new ChequebookRecheck({
      gate: chequebookGate(gateNodes, { info: (message) => logger.debug(message) }),
      intervalMs: config.chequebookRecheckMs,
      store: streamOrchestrator,
      logger,
    }).start();

    // An engine that pulls segments itself must re-attach its fetch loop to recovered streams.
    // Otherwise the recovered stream produces no segments and is finalized as VOD at the timeout.
    for (const streamId of recoveredStreamIds) {
      for (const engine of engines) {
        engine.resumeRecoveredStream?.(streamOrchestrator, streamId);
      }
    }

    logger.info('Stream uploader started, waiting for engine connections');
  } catch (error) {
    logger.error('Failed to start:', error);
    process.exit(1);
  }
}

// Catches its own failure and exits with status 1.
void start();
