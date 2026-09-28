import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from '@streaming-monorepo/web2-admin-common';

import { ApiServerHandle, startApiServer } from './api/server.js';
import { AuthService } from './domain/auth/AuthService.js';
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
import { Logger } from './domain/Logger.js';
import { PostgresAuditLog } from './domain/PostgresAuditLog.js';
import { PublishService } from './domain/PublishService.js';
import { resetOrphanedPublishing } from './domain/resetOrphanedPublishing.js';
import { CatalogueStampRepository, StageRepository } from './domain/StageRepository.js';
import { StageService } from './domain/StageService.js';
import { StreamRenditionRepository } from './domain/StreamRenditionRepository.js';
import { StreamRepository } from './domain/StreamRepository.js';
import { StreamService } from './domain/StreamService.js';
import { StreamStateService } from './domain/StreamStateService.js';
import { config } from './utils/config.js';
import { getErrorMessage, getErrorStack } from './utils/errorUtils.js';

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

/** Enough of a secret to recognise it in a log, not enough to use it. */
function redactSecret(value: string): string {
  if (value === '') return '(unset)';
  return `${value.slice(0, 6)}…(${value.length} chars)`;
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
  logger.info(`[Boot]   postage batch: ${redactSecret(config.postageBatchId)}`);
  logger.info(`[Boot]   feed key: ${redactSecret(config.feedPrivateKey)}`);
  logger.info(`[Boot]   feed: owner ${owner} topic "${config.feedTopic}" (${topicHex})`);
  logger.info(`[Boot]   viewer: ${config.viewerBaseUrl || '(unset → no player links)'}`);
  logger.info(`[Boot]   internal API token: ${redactSecret(config.internalApiToken)}`);
  logger.info(
    `[Boot]   ingest: ${config.ingest.host} srt ${config.ingest.srtPort} rtmp ${
      config.ingest.rtmpPublic
        ? `${config.ingest.rtmpPort} (offered to the console)`
        : 'not offered (INGEST_RTMP_PUBLIC is off)'
    }, passphrase ${
      config.ingest.srtPassphrase ? redactSecret(config.ingest.srtPassphrase) : '(unset)'
    }, key verified ${config.ingest.keyVerified}`,
  );
}

function createFeedGateway(): FeedGateway {
  if (config.feedGateway === 'fake') {
    logger.warn('[Boot] FEED_GATEWAY=fake: feed writes and thumbnail uploads stay in memory, nothing reaches Swarm');
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
  const auditLog = new PostgresAuditLog(database.pool);

  // Logs a line per row it repairs.
  await resetOrphanedPublishing(streamRepository, auditLog);

  const authService = new AuthService(
    userRepository,
    sessionRepository,
    new PostgresCredentialRepository(database.pool),
    auditLog,
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

  const streamService = new StreamService(streamRepository, feed, auditLog);
  const publishService = new PublishService(
    streamRepository,
    renditionRepository,
    feedWriteRepository,
    createFeedGateway(),
    feed,
    auditLog,
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

  const ingestService = new IngestService(streamRepository, config.ingest, auditLog);
  const streamStateService = new StreamStateService(streamRepository, publishService, auditLog);
  const ladderService = new LadderService(streamRepository, renditionRepository, publishService, auditLog);
  const stageService = new StageService(
    new StageRepository(database.pool),
    new CatalogueStampRepository(database.pool),
    auditLog,
  );

  apiServer = startApiServer(
    {
      database,
      authService,
      streamService,
      streamStateService,
      ladderService,
      publishService,
      ingestService,
      stageService,
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

// gracefulShutdown catches every failure and exits with its status, so the signal need not await it.
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
