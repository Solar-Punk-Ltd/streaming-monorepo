import {
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
} from '@streaming-monorepo/web2-admin-common';

import { ApiServerHandle, startApiServer } from './api/server.js';
import { AuthService } from './domain/auth/AuthService.js';
import { ContinuationRepository } from './domain/ContinuationRepository.js';
import { PostgresCredentialRepository } from './domain/auth/PostgresCredentialRepository.js';
import { PostgresSessionRepository } from './domain/auth/PostgresSessionRepository.js';
import { PostgresUserRepository } from './domain/auth/PostgresUserRepository.js';
import { SessionSweep, startSessionSweep } from './domain/auth/sessionSweep.js';
import { BeeFeedGateway } from './domain/BeeFeedGateway.js';
import { Database } from './domain/Database.js';
import { FakeFeedGateway } from './domain/FakeFeedGateway.js';
import type { FeedGateway } from './domain/FeedGateway.js';
import { feedIdentityFrom } from './domain/feedIdentity.js';
import { FeedWriteRepository } from './domain/FeedWriteRepository.js';
import { IngestService } from './domain/IngestService.js';
import { LadderService } from './domain/LadderService.js';
import { LegacyAdoptionRepository } from './domain/LegacyAdoptionRepository.js';
import { Logger } from './domain/Logger.js';
import { ManagedEnrollmentReadiness } from './domain/ManagedEnrollmentReadiness.js';
import { ManagedEnrollmentService } from './domain/ManagedEnrollmentService.js';
import { ManagedLifecycleRepository } from './domain/ManagedLifecycleRepository.js';
import { PublishService } from './domain/PublishService.js';
import { ReleaseGuardReceiptRepository } from './domain/ReleaseGuardReceiptRepository.js';
import { StreamRenditionRepository } from './domain/StreamRenditionRepository.js';
import { StreamRepository } from './domain/StreamRepository.js';
import { StreamService } from './domain/StreamService.js';
import { StreamStateService } from './domain/StreamStateService.js';
import { UploaderCapabilityRepository } from './domain/UploaderCapabilityRepository.js';
import { config } from './utils/config.js';
import { loadActiveAdminArtifact } from './utils/activeAdminArtifact.js';
import { getErrorMessage, getErrorStack } from './utils/errorUtils.js';
import { secretLogSummary } from './utils/secretLogSummary.js';

const logger = Logger.getInstance();

function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '<unparseable>';
  }
}

function logStartupConfig(owner: string, topicHex: string): void {
  logger.info('[Boot] configuration:');
  logger.info(`[Boot]   listen: ${config.host}:${config.port}`);
  logger.info(`[Boot]   database: ${redactDatabaseUrl(config.databaseUrl)}`);
  logger.info(
    `[Boot]   sessions: idle ${SESSION_IDLE_TIMEOUT_MS / 3_600_000}h, absolute ${
      SESSION_ABSOLUTE_TIMEOUT_MS / 86_400_000
    }d, cookie Secure decided per request from X-Forwarded-Proto`,
  );
  logger.info(`[Boot]   feed gateway: ${config.feedGateway}`);
  logger.info(`[Boot]   bee: ${config.beeUrl}`);
  logger.info(
    `[Boot]   postage batch: ${secretLogSummary(config.postageBatchId)}`,
  );
  logger.info(`[Boot]   feed key: ${secretLogSummary(config.feedPrivateKey)}`);
  logger.info(
    `[Boot]   feed: owner ${owner} topic "${config.feedTopic}" (${topicHex})`,
  );
  logger.info(
    `[Boot]   viewer: ${config.viewerBaseUrl || '(unset → no player links)'}`,
  );
  logger.info(
    `[Boot]   internal API token: ${secretLogSummary(config.internalApiToken)}`,
  );
  logger.info(
    `[Boot]   ingest: ${config.ingest.host} srt ${config.ingest.srtPort} rtmp ${config.ingest.rtmpPort}, passphrase ${
      secretLogSummary(config.ingest.srtPassphrase)
    }, key verified ${config.ingest.keyVerified}, managed lifecycle ${
      config.ingest.managedLifecycle
        ? `v1 uploader ${config.ingest.managedLifecycle.uploaderId}`
        : 'disabled'
    }`,
  );
}

function createFeedGateway(): FeedGateway {
  if (config.feedGateway === 'fake') {
    logger.warn(
      '[Boot] FEED_GATEWAY=fake: feed writes and thumbnail uploads stay in memory, nothing reaches Swarm',
    );
    return new FakeFeedGateway();
  }
  return new BeeFeedGateway({
    beeUrl: config.beeUrl,
    postageBatchId: config.postageBatchId,
    feedPrivateKey: config.feedPrivateKey,
    feedTopic: config.feedTopic,
  });
}

let apiServer: ApiServerHandle | undefined;
let database: Database | undefined;
let sessionSweep: SessionSweep | undefined;
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress...');
    return;
  }
  isShuttingDown = true;
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  try {
    if (sessionSweep) {
      sessionSweep.stop();
      sessionSweep = undefined;
    }
    if (apiServer) {
      await apiServer.close();
      apiServer = undefined;
    }
    if (database) {
      await database.close();
      database = undefined;
    }
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    const stack = getErrorStack(error);
    if (stack) logger.error(stack);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const feed = feedIdentityFrom(config.feedPrivateKey, config.feedTopic);
  logStartupConfig(feed.owner, feed.topicHex);

  database = new Database(config.databaseUrl);
  await database.migrate();

  const userRepository = new PostgresUserRepository(database.pool);
  const sessionRepository = new PostgresSessionRepository(database.pool);
  const streamRepository = new StreamRepository(database.pool);
  const renditionRepository = new StreamRenditionRepository(database.pool);
  const feedWriteRepository = new FeedWriteRepository(database.pool);
  const managedLifecycle = new ManagedLifecycleRepository(database.pool);
  const continuations = new ContinuationRepository(database.pool);
  const uploaderCapabilities = config.ingest.managedLifecycle
    ? new UploaderCapabilityRepository(
        database.pool,
        config.ingest.managedLifecycle.uploaderId,
      )
    : undefined;
  const releaseGuardReceipts = config.ingest.managedLifecycle
    ? new ReleaseGuardReceiptRepository(
        database.pool,
        config.ingest.managedLifecycle.uploaderId,
      )
    : undefined;
  const managedEnrollmentReadiness =
    config.ingest.managedLifecycle &&
    uploaderCapabilities &&
    releaseGuardReceipts
      ? new ManagedEnrollmentReadiness(
          releaseGuardReceipts,
          uploaderCapabilities,
          loadActiveAdminArtifact(),
        )
      : undefined;
  const managedEnrollment =
    config.ingest.managedLifecycle && managedEnrollmentReadiness
      ? new ManagedEnrollmentService(
          database.pool,
          managedEnrollmentReadiness,
          config.ingest.managedLifecycle.uploaderId,
        )
      : undefined;
  const legacyAdoptions =
    config.ingest.managedLifecycle && managedEnrollmentReadiness
      ? new LegacyAdoptionRepository(
          database.pool,
          managedEnrollmentReadiness,
          config.ingest.managedLifecycle.uploaderId,
        )
      : undefined;

  const orphans = await streamRepository.resetOrphanedPublishing();
  if (orphans.length > 0) {
    logger.warn(
      `[Boot] reset streams stuck in publishing: ${orphans
        .map((s) => s.topic)
        .join(', ')}`,
    );
  }

  const authService = new AuthService(
    userRepository,
    sessionRepository,
    new PostgresCredentialRepository(database.pool),
  );
  // Prunes what has run out now, and once a day after that. There is no
  // sign-up and no seeded account: a database with no users refuses every
  // sign-in until the CLI has made one.
  sessionSweep = startSessionSweep(authService);

  if ((await authService.countUsers()) === 0) {
    logger.warn(
      '[Boot] no users exist yet. Every route but /api/health, /api/config and /api/internal refuses until one is created with: node dist/cli.js user:add <username>',
    );
  }

  const streamService = new StreamService(streamRepository, feed);
  const publishService = new PublishService(
    streamRepository,
    feedWriteRepository,
    createFeedGateway(),
    feed,
    managedEnrollment,
  );
  // After the orphan reset, so the dry-run diff sees the repaired statuses.
  // Never fatal: this is a cross-check of the feed, and the API is fully
  // usable whatever it finds.
  try {
    const check = await publishService.checkFeedOnBoot();
    logger.info(
      `[Boot] feed: last write recorded ${check.recorded ?? 'none'}, network head ${check.network ?? 'none'}${check.adopted ? ' (adopted)' : ''}`,
    );
  } catch (error) {
    logger.warn(`[Boot] feed check failed: ${getErrorMessage(error)}`);
  }

  const ingestService = new IngestService(streamRepository, config.ingest);
  const streamStateService = new StreamStateService(
    streamRepository,
    publishService,
  );
  const ladderService = new LadderService(
    streamRepository,
    renditionRepository,
    publishService,
  );

  apiServer = startApiServer(
    {
      database,
      authService,
      streamService,
      streamStateService,
      ladderService,
      managedLifecycle,
      continuations,
      legacyAdoptions,
      publishService,
      uploaderCapabilities,
      releaseGuardReceipts,
      ingestService,
      internalApiToken: config.internalApiToken,
      feed,
      viewerBaseUrl: config.viewerBaseUrl,
    },
    config.port,
    config.host,
  );
}

function stop() {
  setTimeout(() => process.exit(1), 1000).unref();
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  stop();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  const stack = getErrorStack(reason);
  if (stack) logger.error(stack);
  stop();
});

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  const stack = getErrorStack(err);
  if (stack) logger.error(stack);
  stop();
});
